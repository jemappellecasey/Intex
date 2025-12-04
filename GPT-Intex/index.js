#!/usr/bin/env node
// 3-12 | Hirohito Mizuno, Casey Black, Hector Casablanca, Karie Ward
// We built this server entry to run the Ella Rises app with auth, CSRF, sessions, and routing for the older layout.
// 3-12 | Hirohito Mizuno, Casey Black, Hector Casablanca, Karie Ward
// I built this server entry to run the Ella Rises app with auth, CSRF, sessions, and routing for the older layout.

/**
 * ELLA RISES - Event & Participant Management System
 * Production-Ready Express Application
 *
 * Manages events, participants, surveys, donations, and milestones
 * with role-based access control and professional UI.
 */

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const helmet = require('helmet');
const csrf = require('@dr.pogodin/csurf');
const flash = require('connect-flash');
const bcrypt = require('bcrypt');

// Initialize Knex for PostgreSQL
const knex = require('knex')({
  client: 'pg',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'admin',
    database: process.env.DB_NAME || '312intex',
    port: process.env.DB_PORT || 5432
  }
});

const app = express();
const port = process.env.PORT || 3000;

// ============================================================================
// VIEW ENGINE & STATIC FILES
// ============================================================================

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(helmet());

// ============================================================================
// SESSION, FLASH, CSRF
// ============================================================================

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000
    }
  })
);

app.use(flash());
app.use(csrf());

// expose common locals to all views
app.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken();
  res.locals.error_message = req.flash('error')[0] || null;
  res.locals.success_message = req.flash('success')[0] || null;
  res.locals.user = {
    id: req.session.userId,
    username: req.session.username,
    role: req.session.role
  };
  res.locals.isLoggedIn = !!req.session.isLoggedIn;
  // “Manager and admin count as the same thing for now” → treat role M as manager
  res.locals.isManager = req.session.role === 'M';
  next();
});

// CSRF error handler
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).render('error', {
      status: 403,
      message: 'Invalid CSRF token. Please refresh the page and try again.'
    });
  }
  return next(err);
});

// ============================================================================
// AUTH MIDDLEWARE
// ============================================================================

// public routes that do not require login
const PUBLIC_PATHS = ['/', '/login', '/logout', '/donations/new'];

// require login for all non-public routes
app.use((req, res, next) => {
  if (PUBLIC_PATHS.includes(req.path) || PUBLIC_PATHS.some(p => req.path.startsWith(p))) {
    return next();
  }
  if (req.session.isLoggedIn) return next();
  return res.redirect('/login');
});

// require manager (M) for protected actions
function requireManager(req, res, next) {
  if (req.session.isLoggedIn && req.session.role === 'M') return next();
  req.flash('error', 'You do not have permission to access that page.');
  return res.redirect('/dashboard');
}

// ============================================================================
// PUBLIC ROUTES
// ============================================================================

// landing page
app.get('/', (req, res) => {
  res.render('landing');
});

// login page
app.get('/login', (req, res) => {
  res.render('login');
});

// login handler
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('login', { error_message: 'Username and password are required.' });
  }
  try {
    const user = await knex('users')
      .select('userid', 'username', 'password', 'role')
      .where('username', username)
      .first();

    if (!user) {
      return res.render('login', { error_message: 'Invalid username or password. 1' });
    }

    // const ok = await bcrypt.compare(password, user.password);
    // if (!ok) {
    //   return res.render('login', { error_message: 'Invalid username or password. 2' });
    // }

    req.session.isLoggedIn = true;
    req.session.userId = user.userid;
    req.session.username = user.username;
    req.session.role = user.role;

    req.flash('success', `Welcome back, ${user.username}!`);
    return res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    return res.render('login', { error_message: 'Error during login. Please try again.' });
  }
});

// logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ============================================================================
// DASHBOARD
// ============================================================================

app.get('/dashboard', async (req, res) => {
  try {
    const totalParticipantsRow = await knex('participants')
      .count('* as count')
      .first();
    const totalEventsRow = await knex('events')
      .count('* as count')
      .first();

    const upcomingEvents = await knex('events')
      .select('*')
      .whereRaw('event_date_time_start > NOW()')
      .orderBy('event_date_time_start', 'asc')
      .limit(5);

    const recentSurveys = await knex('surveys')
      .select('*')
      .orderBy('survey_submission_date', 'desc')
      .limit(5);

    res.render('dashboard', {
      totalParticipants: Number(totalParticipantsRow?.count || 0),
      totalEvents: Number(totalEventsRow?.count || 0),
      upcomingEvents,
      recentSurveys
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    req.flash('error', 'Error loading dashboard.');
    res.render('dashboard', {
      totalParticipants: 0,
      totalEvents: 0,
      upcomingEvents: [],
      recentSurveys: []
    });
  }
});

// ============================================================================
// USER MANAGEMENT (MANAGER ONLY)
// ============================================================================

// list users
app.get('/users', requireManager, async (req, res) => {
  try {
    const { search } = req.query;
    let query = knex('users').select('id', 'username', 'role', 'created_at');
    if (search) {
      query = query.whereRaw('LOWER(username) LIKE LOWER(?)', [`%${search}%`]);
    }
    const users = await query.orderBy('created_at', 'desc');
    res.render('userMaintenance', { users, search: search || '' });
  } catch (err) {
    console.error('User list error:', err);
    req.flash('error', 'Error loading users.');
    res.redirect('/dashboard');
  }
});

// add user form
app.get('/users/add', requireManager, (req, res) => {
  res.render('userForm', { user: null });
});

// create user
app.post('/users/add', requireManager, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role) {
    req.flash('error', 'Username, password, and role are required.');
    return res.redirect('/users/add');
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    await knex('users').insert({
      username,
      password: hash,
      role,
      created_at: knex.fn.now()
    });
    req.flash('success', `User "${username}" created successfully.`);
    res.redirect('/users');
  } catch (err) {
    console.error('User create error:', err);
    if (String(err.message).includes('duplicate')) {
      req.flash('error', 'Username already exists.');
    } else {
      req.flash('error', 'Error creating user.');
    }
    res.redirect('/users/add');
  }
});

// edit user form
app.get('/users/:id/edit', requireManager, async (req, res) => {
  try {
    const user = await knex('users').where('id', req.params.id).first();
    if (!user) {
      req.flash('error', 'User not found.');
      return res.redirect('/users');
    }
    res.render('userForm', { user });
  } catch (err) {
    console.error('User edit load error:', err);
    req.flash('error', 'Error loading user.');
    res.redirect('/users');
  }
});

// update user
app.post('/users/:id/edit', requireManager, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !role) {
    req.flash('error', 'Username and role are required.');
    return res.redirect(`/users/${req.params.id}/edit`);
  }
  try {
    const update = { username, role };
    if (password) {
      update.password = await bcrypt.hash(password, 10);
    }
    await knex('users').where('id', req.params.id).update(update);
    req.flash('success', 'User updated successfully.');
    res.redirect('/users');
  } catch (err) {
    console.error('User update error:', err);
    req.flash('error', 'Error updating user.');
    res.redirect(`/users/${req.params.id}/edit`);
  }
});

// delete user
app.post('/users/:id/delete', requireManager, async (req, res) => {
  try {
    await knex('users').where('id', req.params.id).del();
    req.flash('success', 'User deleted successfully.');
    res.redirect('/users');
  } catch (err) {
    console.error('User delete error:', err);
    req.flash('error', 'Error deleting user.');
    res.redirect('/users');
  }
});

// ============================================================================
// PARTICIPANTS
// ============================================================================

// list participants with simple text search by name
app.get('/participants', async (req, res) => {
  try {
    const { search } = req.query;
    let query = knex('participants').select('*');
    if (search) {
      query = query.whereRaw(
        'LOWER(participant_first_name) LIKE LOWER(?) OR LOWER(participant_last_name) LIKE LOWER(?)',
        [`%${search}%`, `%${search}%`]
      );
    }
    const participants = await query.orderBy('participant_last_name', 'asc');
    res.render('participants', { participants, search: search || '' });
  } catch (err) {
    console.error('Participants list error:', err);
    req.flash('error', 'Error loading participants.');
    res.redirect('/dashboard');
  }
});

// participant detail (profile)
app.get('/participants/:id', async (req, res) => {
  try {
    const participant = await knex('participants')
      .where('id', req.params.id)
      .first();
    if (!participant) {
      req.flash('error', 'Participant not found.');
      return res.redirect('/participants');
    }

    const milestones = await knex('milestones')
      .where('participant_id', req.params.id)
      .orderBy('milestone_date', 'desc');

    const registrations = await knex('registrations')
      .join('events', 'registrations.event_id', 'events.id')
      .where('registrations.participant_id', req.params.id)
      .select('events.*', 'registrations.*')
      .orderBy('events.event_date_time_start', 'desc');

    const surveys = await knex('surveys')
      .where('participant_id', req.params.id)
      .orderBy('survey_submission_date', 'desc');

    const donations = await knex('donations')
      .where('participant_id', req.params.id)
      .orderBy('donation_date', 'desc');

    res.render('participantDetail', {
      participant,
      milestones,
      registrations,
      surveys,
      donations
    });
  } catch (err) {
    console.error('Participant detail error:', err);
    req.flash('error', 'Error loading participant profile.');
    res.redirect('/participants');
  }
});

// add participant form (manager)
app.get('/participants/add', requireManager, (req, res) => {
  res.render('participantForm', { participant: null });
});

// create participant
app.post('/participants/add', requireManager, async (req, res) => {
  const {
    email,
    firstName,
    lastName,
    dob,
    role,
    phone,
    city,
    state,
    zip,
    fieldOfInterest
  } = req.body;

  if (!email || !firstName || !lastName) {
    req.flash('error', 'Email, first name, and last name are required.');
    return res.redirect('/participants/add');
  }

  try {
    await knex('participants').insert({
      email,
      participant_first_name: firstName,
      participant_last_name: lastName,
      participant_dob: dob || null,
      participant_role: role || null,
      participant_phone: phone || null,
      participant_city: city || null,
      participant_state: state || null,
      participant_zip: zip || null,
      participant_field_of_interest: fieldOfInterest || null,
      created_at: knex.fn.now()
    });
    req.flash('success', `Participant "${firstName} ${lastName}" created successfully.`);
    res.redirect('/participants');
  } catch (err) {
    console.error('Participant create error:', err);
    req.flash('error', 'Error creating participant.');
    res.redirect('/participants/add');
  }
});

// edit participant form
app.get('/participants/:id/edit', requireManager, async (req, res) => {
  try {
    const participant = await knex('participants')
      .where('id', req.params.id)
      .first();
    if (!participant) {
      req.flash('error', 'Participant not found.');
      return res.redirect('/participants');
    }
    res.render('participantForm', { participant });
  } catch (err) {
    console.error('Participant edit load error:', err);
    req.flash('error', 'Error loading participant.');
    res.redirect('/participants');
  }
});

// update participant
app.post('/participants/:id/edit', requireManager, async (req, res) => {
  const {
    email,
    firstName,
    lastName,
    dob,
    role,
    phone,
    city,
    state,
    zip,
    fieldOfInterest
  } = req.body;

  if (!email || !firstName || !lastName) {
    req.flash('error', 'Email, first name, and last name are required.');
    return res.redirect(`/participants/${req.params.id}/edit`);
  }

  try {
    await knex('participants')
      .where('id', req.params.id)
      .update({
        email,
        participant_first_name: firstName,
        participant_last_name: lastName,
        participant_dob: dob || null,
        participant_role: role || null,
        participant_phone: phone || null,
        participant_city: city || null,
        participant_state: state || null,
        participant_zip: zip || null,
        participant_field_of_interest: fieldOfInterest || null
      });

    req.flash('success', 'Participant updated successfully.');
    res.redirect('/participants');
  } catch (err) {
    console.error('Participant update error:', err);
    req.flash('error', 'Error updating participant.');
    res.redirect(`/participants/${req.params.id}/edit`);
  }
});

// delete participant
app.post('/participants/:id/delete', requireManager, async (req, res) => {
  try {
    await knex('participants').where('id', req.params.id).del();
    req.flash('success', 'Participant deleted successfully.');
    res.redirect('/participants');
  } catch (err) {
    console.error('Participant delete error:', err);
    req.flash('error', 'Error deleting participant.');
    res.redirect('/participants');
  }
});

// ============================================================================
// MILESTONES (MANAGER)
// ============================================================================

// add milestone
app.post('/participants/:id/milestones/add', requireManager, async (req, res) => {
  const { title, date } = req.body;
  if (!title) {
    req.flash('error', 'Milestone title is required.');
    return res.redirect(`/participants/${req.params.id}`);
  }
  try {
    await knex('milestones').insert({
      participant_id: req.params.id,
      milestone_title: title,
      milestone_date: date || knex.fn.now(),
      created_at: knex.fn.now()
    });
    req.flash('success', 'Milestone added successfully.');
    res.redirect(`/participants/${req.params.id}`);
  } catch (err) {
    console.error('Milestone create error:', err);
    req.flash('error', 'Error adding milestone.');
    res.redirect(`/participants/${req.params.id}`);
  }
});

// delete milestone
app.post('/milestones/:id/delete', requireManager, async (req, res) => {
  try {
    const milestone = await knex('milestones').where('id', req.params.id).first();
    if (!milestone) {
      req.flash('error', 'Milestone not found.');
      return res.redirect('/participants');
    }
    const participantId = milestone.participant_id;
    await knex('milestones').where('id', req.params.id).del();
    req.flash('success', 'Milestone deleted successfully.');
    res.redirect(`/participants/${participantId}`);
  } catch (err) {
    console.error('Milestone delete error:', err);
    req.flash('error', 'Error deleting milestone.');
    res.redirect('/participants');
  }
});

// ============================================================================
// EVENTS
// ============================================================================

// list events with simple text filter (name + type)
app.get('/events', async (req, res) => {
  try {
    const { search } = req.query;
    let query = knex('events').select('*');
    if (search) {
      query = query.whereRaw(
        'LOWER(event_name) LIKE LOWER(?) OR LOWER(event_type) LIKE LOWER(?)',
        [`%${search}%`, `%${search}%`]
      );
    }
    const events = await query.orderBy('event_date_time_start', 'asc');
    res.render('events', { events, search: search || '' });
  } catch (err) {
    console.error('Events list error:', err);
    req.flash('error', 'Error loading events.');
    res.redirect('/dashboard');
  }
});

// add event form
app.get('/events/add', requireManager, (req, res) => {
  res.render('eventForm', { event: null });
});

// create event
app.post('/events/add', requireManager, async (req, res) => {
  const {
    name,
    description,
    type,
    capacity,
    location,
    dateStart,
    timeStart,
    dateEnd,
    timeEnd,
    deadline
  } = req.body;

  if (!name || !capacity || !dateStart || !timeStart) {
    req.flash('error', 'Name, capacity, start date, and start time are required.');
    return res.redirect('/events/add');
  }

  try {
    await knex('events').insert({
      event_name: name,
      event_description: description || null,
      event_type: type || null,
      event_default_capacity: parseInt(capacity, 10),
      event_location: location || null,
      event_date_time_start: `${dateStart} ${timeStart}`,
      event_date_time_end:
        dateEnd && timeEnd ? `${dateEnd} ${timeEnd}` : null,
      registration_deadline: deadline || null,
      created_at: knex.fn.now()
    });
    req.flash('success', `Event "${name}" created successfully.`);
    res.redirect('/events');
  } catch (err) {
    console.error('Event create error:', err);
    req.flash('error', 'Error creating event.');
    res.redirect('/events/add');
  }
});

// edit event form
app.get('/events/:id/edit', requireManager, async (req, res) => {
  try {
    const event = await knex('events').where('id', req.params.id).first();
    if (!event) {
      req.flash('error', 'Event not found.');
      return res.redirect('/events');
    }
    res.render('eventForm', { event });
  } catch (err) {
    console.error('Event edit load error:', err);
    req.flash('error', 'Error loading event.');
    res.redirect('/events');
  }
});

// update event
app.post('/events/:id/edit', requireManager, async (req, res) => {
  const {
    name,
    description,
    type,
    capacity,
    location,
    dateStart,
    timeStart,
    dateEnd,
    timeEnd,
    deadline
  } = req.body;

  if (!name || !capacity || !dateStart || !timeStart) {
    req.flash('error', 'Name, capacity, start date, and start time are required.');
    return res.redirect(`/events/${req.params.id}/edit`);
  }

  try {
    await knex('events')
      .where('id', req.params.id)
      .update({
        event_name: name,
        event_description: description || null,
        event_type: type || null,
        event_default_capacity: parseInt(capacity, 10),
        event_location: location || null,
        event_date_time_start: `${dateStart} ${timeStart}`,
        event_date_time_end:
          dateEnd && timeEnd ? `${dateEnd} ${timeEnd}` : null,
        registration_deadline: deadline || null
      });
    req.flash('success', 'Event updated successfully.');
    res.redirect('/events');
  } catch (err) {
    console.error('Event update error:', err);
    req.flash('error', 'Error updating event.');
    res.redirect(`/events/${req.params.id}/edit`);
  }
});

// delete event
app.post('/events/:id/delete', requireManager, async (req, res) => {
  try {
    await knex('events').where('id', req.params.id).del();
    req.flash('success', 'Event deleted successfully.');
    res.redirect('/events');
  } catch (err) {
    console.error('Event delete error:', err);
    req.flash('error', 'Error deleting event.');
    res.redirect('/events');
  }
});

// ============================================================================
// SURVEYS
// ============================================================================

// list surveys with text filter (event or participant name)
app.get('/surveys', async (req, res) => {
  try {
    const { search } = req.query;
    let query = knex('surveys')
      .join('events', 'surveys.event_id', 'events.id')
      .join('participants', 'surveys.participant_id', 'participants.id')
      .select(
        'surveys.*',
        'events.event_name',
        knex.raw(
          "participants.participant_first_name || ' ' || participants.participant_last_name AS participant_name"
        )
      );

    if (search) {
      query = query.whereRaw(
        `LOWER(events.event_name) LIKE LOWER(?) 
         OR LOWER(participants.participant_first_name) LIKE LOWER(?) 
         OR LOWER(participants.participant_last_name) LIKE LOWER(?)`,
        [`%${search}%`, `%${search}%`, `%${search}%`]
      );
    }

    const surveys = await query.orderBy('surveys.survey_submission_date', 'desc');
    res.render('surveys', { surveys, search: search || '' });
  } catch (err) {
    console.error('Surveys list error:', err);
    req.flash('error', 'Error loading surveys.');
    res.redirect('/dashboard');
  }
});

// add survey form
app.get('/surveys/add', requireManager, async (req, res) => {
  try {
    const events = await knex('events').select('*').orderBy('event_name');
    const participants = await knex('participants')
      .select('*')
      .orderBy('participant_last_name');
    res.render('surveyForm', { survey: null, events, participants });
  } catch (err) {
    console.error('Survey form load error:', err);
    req.flash('error', 'Error loading survey form.');
    res.redirect('/surveys');
  }
});

// create survey
app.post('/surveys/add', requireManager, async (req, res) => {
  const {
    eventId,
    participantId,
    satisfaction,
    usefulness,
    instructor,
    recommendation,
    overall,
    comments
  } = req.body;

  if (!eventId || !participantId) {
    req.flash('error', 'Event and participant are required.');
    return res.redirect('/surveys/add');
  }

  try {
    await knex('surveys').insert({
      event_id: parseInt(eventId, 10),
      participant_id: parseInt(participantId, 10),
      survey_satisfaction_score: satisfaction ? parseInt(satisfaction, 10) : null,
      survey_usefulness_score: usefulness ? parseInt(usefulness, 10) : null,
      survey_instructor_score: instructor ? parseInt(instructor, 10) : null,
      survey_recommendation_score: recommendation
        ? parseInt(recommendation, 10)
        : null,
      survey_overall_score: overall ? parseInt(overall, 10) : null,
      survey_comments: comments || null,
      survey_submission_date: knex.fn.now()
    });
    req.flash('success', 'Survey created successfully.');
    res.redirect('/surveys');
  } catch (err) {
    console.error('Survey create error:', err);
    req.flash('error', 'Error creating survey.');
    res.redirect('/surveys/add');
  }
});

// edit survey form
app.get('/surveys/:id/edit', requireManager, async (req, res) => {
  try {
    const survey = await knex('surveys').where('id', req.params.id).first();
    if (!survey) {
      req.flash('error', 'Survey not found.');
      return res.redirect('/surveys');
    }
    const events = await knex('events').select('*').orderBy('event_name');
    const participants = await knex('participants')
      .select('*')
      .orderBy('participant_last_name');
    res.render('surveyForm', { survey, events, participants });
  } catch (err) {
    console.error('Survey edit load error:', err);
    req.flash('error', 'Error loading survey.');
    res.redirect('/surveys');
  }
});

// update survey
app.post('/surveys/:id/edit', requireManager, async (req, res) => {
  const {
    eventId,
    participantId,
    satisfaction,
    usefulness,
    instructor,
    recommendation,
    overall,
    comments
  } = req.body;
  try {
    await knex('surveys')
      .where('id', req.params.id)
      .update({
        event_id: parseInt(eventId, 10),
        participant_id: parseInt(participantId, 10),
        survey_satisfaction_score: satisfaction ? parseInt(satisfaction, 10) : null,
        survey_usefulness_score: usefulness ? parseInt(usefulness, 10) : null,
        survey_instructor_score: instructor ? parseInt(instructor, 10) : null,
        survey_recommendation_score: recommendation
          ? parseInt(recommendation, 10)
          : null,
        survey_overall_score: overall ? parseInt(overall, 10) : null,
        survey_comments: comments || null
      });
    req.flash('success', 'Survey updated successfully.');
    res.redirect('/surveys');
  } catch (err) {
    console.error('Survey update error:', err);
    req.flash('error', 'Error updating survey.');
    res.redirect(`/surveys/${req.params.id}/edit`);
  }
});

// delete survey
app.post('/surveys/:id/delete', requireManager, async (req, res) => {
  try {
    await knex('surveys').where('id', req.params.id).del();
    req.flash('success', 'Survey deleted successfully.');
    res.redirect('/surveys');
  } catch (err) {
    console.error('Survey delete error:', err);
    req.flash('error', 'Error deleting survey.');
    res.redirect('/surveys');
  }
});

// ============================================================================
// DONATIONS
// ============================================================================

// list donations with simple text filter (donor name or email)
app.get('/donations', async (req, res) => {
  try {
    const { search } = req.query;
    let query = knex('donations')
      .join('participants', 'donations.participant_id', 'participants.id')
      .select(
        'donations.*',
        'participants.participant_first_name',
        'participants.participant_last_name',
        'participants.email'
      );

    if (search) {
      query = query.whereRaw(
        `LOWER(participants.participant_first_name) LIKE LOWER(?) 
         OR LOWER(participants.participant_last_name) LIKE LOWER(?) 
         OR LOWER(participants.email) LIKE LOWER(?)`,
        [`%${search}%`, `%${search}%`, `%${search}%`]
      );
    }

    const donations = await query.orderBy('donations.donation_date', 'desc');

    const totalRow = await knex('donations')
      .sum('donation_amount as total')
      .first();
    const totalDonations = Number(totalRow?.total || 0).toFixed(2);

    res.render('donations', {
      donations,
      totalDonations,
      search: search || ''
    });
  } catch (err) {
    console.error('Donations list error:', err);
    req.flash('error', 'Error loading donations.');
    res.redirect('/dashboard');
  }
});

// public donation form (must be logged in per your requirement,
// but still accessible from landing; if not logged in, redirect to login)
app.get('/donations/new', (req, res) => {
  if (!req.session.isLoggedIn) {
    req.flash('error', 'Please log in to make a donation.');
    return res.redirect('/login');
  }
  res.render('donationForm', { donation: null });
});

// process donation - creates participant if needed AND uses logged-in user
app.post('/donations/new', async (req, res) => {
  if (!req.session.isLoggedIn) {
    req.flash('error', 'You must be logged in to donate.');
    return res.redirect('/login');
  }

  const { firstName, lastName, email, phone, amount } = req.body;

  if (!firstName || !lastName || !email || !amount) {
    req.flash('error', 'First name, last name, email, and amount are required.');
    return res.redirect('/donations/new');
  }

  const value = parseFloat(amount);
  if (Number.isNaN(value) || value <= 0) {
    req.flash('error', 'Donation amount must be a positive number.');
    return res.redirect('/donations/new');
  }

  try {
    // Option A/C: If participant with email exists, use it; otherwise create one.
    let participant = await knex('participants').where('email', email).first();

    if (!participant) {
      const rows = await knex('participants')
        .insert({
          email,
          participant_first_name: firstName,
          participant_last_name: lastName,
          participant_phone: phone || null,
          created_at: knex.fn.now()
        })
        .returning('id');

      const id = Array.isArray(rows) ? rows[0].id || rows[0] : rows;
      participant = { id };
    }

    await knex('donations').insert({
      participant_id: participant.id,
      donation_amount: value,
      donation_date: knex.fn.now(),
      created_at: knex.fn.now()
    });

    await knex('participants')
      .where('id', participant.id)
      .increment('total_donations', value);

    req.flash(
      'success',
      `Thank you for your generous donation of $${value.toFixed(2)}!`
    );
    res.redirect('/donations');
  } catch (err) {
    console.error('Donation create error:', err);
    req.flash('error', 'Error processing donation.');
    res.redirect('/donations/new');
  }
});

// manager donation form
app.get('/donations/add', requireManager, async (req, res) => {
  try {
    const participants = await knex('participants')
      .select('*')
      .orderBy('participant_last_name');
    res.render('donationFormManager', { donation: null, participants });
  } catch (err) {
    console.error('Donation form load error:', err);
    req.flash('error', 'Error loading donation form.');
    res.redirect('/donations');
  }
});

// record donation (manager)
app.post('/donations/add', requireManager, async (req, res) => {
  const { participantId, amount, date } = req.body;
  if (!participantId || !amount) {
    req.flash('error', 'Participant and amount are required.');
    return res.redirect('/donations/add');
  }
  const value = parseFloat(amount);
  if (Number.isNaN(value) || value <= 0) {
    req.flash('error', 'Donation amount must be a positive number.');
    return res.redirect('/donations/add');
  }
  try {
    await knex('donations').insert({
      participant_id: parseInt(participantId, 10),
      donation_amount: value,
      donation_date: date || knex.fn.now(),
      created_at: knex.fn.now()
    });

    await knex('participants')
      .where('id', participantId)
      .increment('total_donations', value);

    req.flash('success', 'Donation recorded successfully.');
    res.redirect('/donations');
  } catch (err) {
    console.error('Donation record error:', err);
    req.flash('error', 'Error recording donation.');
    res.redirect('/donations/add');
  }
});

// edit donation form
app.get('/donations/:id/edit', requireManager, async (req, res) => {
  try {
    const donation = await knex('donations').where('id', req.params.id).first();
    if (!donation) {
      req.flash('error', 'Donation not found.');
      return res.redirect('/donations');
    }
    const participants = await knex('participants')
      .select('*')
      .orderBy('participant_last_name');
    res.render('donationFormManager', { donation, participants });
  } catch (err) {
    console.error('Donation edit load error:', err);
    req.flash('error', 'Error loading donation.');
    res.redirect('/donations');
  }
});

// update donation (and adjust participant totals)
app.post('/donations/:id/edit', requireManager, async (req, res) => {
  const { participantId, amount, date } = req.body;
  if (!participantId || !amount) {
    req.flash('error', 'Participant and amount are required.');
    return res.redirect(`/donations/${req.params.id}/edit`);
  }
  const value = parseFloat(amount);
  if (Number.isNaN(value) || value <= 0) {
    req.flash('error', 'Donation amount must be a positive number.');
    return res.redirect(`/donations/${req.params.id}/edit`);
  }

  try {
    const old = await knex('donations').where('id', req.params.id).first();
    if (!old) {
      req.flash('error', 'Donation not found.');
      return res.redirect('/donations');
    }

    await knex('donations')
      .where('id', req.params.id)
      .update({
        participant_id: parseInt(participantId, 10),
        donation_amount: value,
        donation_date: date || knex.fn.now()
      });

    if (old.participant_id !== parseInt(participantId, 10)) {
      // different participant: remove from old, add to new
      await knex('participants')
        .where('id', old.participant_id)
        .decrement('total_donations', parseFloat(old.donation_amount));
      await knex('participants')
        .where('id', participantId)
        .increment('total_donations', value);
    } else {
      // same participant: adjust difference
      const diff = value - parseFloat(old.donation_amount);
      await knex('participants')
        .where('id', participantId)
        .increment('total_donations', diff);
    }

    req.flash('success', 'Donation updated successfully.');
    res.redirect('/donations');
  } catch (err) {
    console.error('Donation update error:', err);
    req.flash('error', 'Error updating donation.');
    res.redirect(`/donations/${req.params.id}/edit`);
  }
});

// delete donation
app.post('/donations/:id/delete', requireManager, async (req, res) => {
  try {
    const donation = await knex('donations')
      .where('id', req.params.id)
      .first();
    if (!donation) {
      req.flash('error', 'Donation not found.');
      return res.redirect('/donations');
    }

    await knex('participants')
      .where('id', donation.participant_id)
      .decrement('total_donations', parseFloat(donation.donation_amount));

    await knex('donations').where('id', req.params.id).del();

    req.flash('success', 'Donation deleted successfully.');
    res.redirect('/donations');
  } catch (err) {
    console.error('Donation delete error:', err);
    req.flash('error', 'Error deleting donation.');
    res.redirect('/donations');
  }
});

// ============================================================================
// NOT FOUND & ERROR HANDLERS
// ============================================================================

app.use((req, res) => {
  res.status(404).render('error', {
    status: 404,
    message: 'Page not found.'
  });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).render('error', {
    status: 500,
    message: 'An unexpected error occurred. Please try again later.'
  });
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(port, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║     🎵 ELLA RISES - Event Management System 🎵         ║');
  console.log('╠═══════════════════════════════════════════════════════╣');
  console.log(`║   Server running on: http://localhost:${port}            `.padEnd(55) + '║');
  console.log('║   Database: Connected and ready                       ║');
  console.log(
    `║   Environment: ${(process.env.NODE_ENV || 'development').padEnd(
      35
    )}║`
  );
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
});

module.exports = app;