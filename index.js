// npm install express ejs knex pg express-session multer bcrypt helmet '@dr.pogodin/csurf' connect-flash nodemailer
/*
Participants
Events
Surveys (post)
Milestones (you will need to support the milestones setup which can then be assigned to participants in a 1 to many relationship)
Donations

*/

require('dotenv').config();

const express = require("express");
const session = require("express-session");
const path = require("path");
let bodyParser = require("body-parser");

const helmet = require("helmet");
const csrf = require("@dr.pogodin/csurf");   // CSRF
const flash = require("connect-flash");      // flash message
const bcrypt = require("bcrypt");            // password hash
const nodemailer = require("nodemailer");    // if the mail needed


//We need to fix it before deploying the AWS!!
const knex = require("knex")({
    client: "pg",
    connection: {
        host : process.env.DB_HOST || "localhost",
        user : process.env.DB_USER || "postgres",
        password : process.env.DB_PASSWORD || "admin",
        database : process.env.DB_NAME || "312intex",
        port : process.env.DB_PORT || 5432
    }
});
const app = express();
const port = process.env.PORT || 3000;

app.set("view engine", "ejs");

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

//app.use(helmet());


// Replace the default helmet() with this configuration
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],

        // Allow Tableau scripts + inline script required for embed
        "script-src": [
          "'self'",
          "'unsafe-inline'",                     // Required because the Tableau embed uses inline <script>
          "https://public.tableau.com",
          "https://public.tableau.com/javascripts/api/"
        ],

        "script-src-attr": ["'self'", "'unsafe-inline'"],

        // Allow embedding Tableau dashboards (iframe/object)
        "frame-src": [
          "'self'",
          "https://public.tableau.com"
        ],

        // Allow Tableau static images + data: URIs
        "img-src": [
          "'self'",
          "data:",
          "https://public.tableau.com"
        ],

        // Allow inline styles required by Tableau embed
        "style-src": [
          "'self'",
          "'unsafe-inline'",
          "https://public.tableau.com"
        ],

        // Allow Tableau API calls if needed
        "connect-src": [
          "'self'",
          "https://public.tableau.com"
        ],
      },
    },

    // Disable COEP because it breaks external embeds (including Tableau)
    crossOriginEmbedderPolicy: false,
  })
);


app.use(
    session({
        secret: process.env.SESSION_SECRET || 'fallback-secret-key', 
        resave: false,
        saveUninitialized: false,
    })
);

app.use(flash());

app.use(csrf());


//This app.use helps to be use CSFRToken and flash in view folder.
app.use((req, res, next) => {
    res.locals.csrfToken = req.csrfToken();
    const flashError = req.flash("error");
    if (!res.locals.error_message) {
        res.locals.error_message = flashError[0] || null;
    }
    next();
});

//checking the CSFR login error
app.use((err, req, res, next) => {
    if (err.code === "EBADCSRFTOKEN") {
        return res.status(403).send("Invalid CSRF token.");
    }
    next(err);
});


//Login check
app.use((req, res, next)=> {
    if(req.path === '/' || req.path === '/login' || req.path === '/logout'){
        return next();
    }
    if (req.session.isLoggedIn){
        next();
    }
    else{
        res.render('login', {error_message: 'Please log in the access this page'})
    }
});



//This is security for website if the user are manager or not.
function requireManager(req, res, next) {
    if (req.session.isLoggedIn && req.session.role === 'admin') {
        return next();
    }
    return res.render('login', { error_message: 'You do not have permission to view this page.' });
}

//First, all user go to the landing page
app.get('/', (req, res) => {
  res.render('landing', { 
    
  });
});



app.get('/login', (req, res) => {
   
    res.render('login', { error_message: res.locals.error_message || null });
});


app.post('/login', async (req, res) => {
    const sName = req.body.username;
    const sPassword = req.body.password;

    console.log("Login attempt:");
    console.log("Username:", sName);
    console.log("Password:", sPassword);
    
    try {
        // get the one username
        const user = await knex('users')
            .select('userid', 'username', 'password', 'role')  
            .where('username', sName)
            .first();

        // If user cannot be finded, send the message to the login page-> Invalid Login
        if (!user) {
            return res.render('login', { error_message: 'Invalid Login no user' });
        }

        // // Check plain text password
        // const match = Boolean(sPassword === user.password)
        // console.log(match)
        // It is going to check password by bccrypt 
        const match = await bcrypt.compare(sPassword, user.password);

        //If it does not match the password, send the message to the login page-> Invalid Login
        if (!match) {
            return res.render('login', { error_message: 'Invalid Login' });
        }

        // There are going to set the session .
        req.session.isLoggedIn = true;
        req.session.username = user.username;
        req.session.role = user.role;

        return res.redirect('/dashboard');

    } catch (err) {
        console.error('login error', err);
        return res.render('login', { error_message: 'Login error. Please try again.' });
    }
});

app.get("/logout", (req, res) => {
    // Get rid of the session object
    req.session.destroy((err) => {
        if (err) {
            console.log(err);
        }
        res.redirect("/");
    });
});

app.get('/dashboard', (req, res) => {
    if (!req.session.isLoggedIn) {
        return res.render('login', { error_message: null });
    }

    res.render('dashboard', { 
        error_message: null,
        isAdmin: req.session.role === 'admin',
        Username: req.session.username
    });
});


app.get('/participants', async (req, res) => {
  if (!req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }

  const pageSize = 25;
  const page = parseInt(req.query.page, 10) || 1;
  const offset = (page - 1) * pageSize;

  // filters from query string
  const { milestoneTitle, name, email, phone } = req.query;

  try {
    // Base query with LEFT JOIN to milestones
    const baseQuery = knex('participants as p')
      .leftJoin('milestones as m', 'p.participantid', 'm.participantid')
      .groupBy('p.participantid')
      .select(
        'p.*',
        // aggregate milestone titles into one string per participant
        knex.raw(
          "COALESCE(string_agg(DISTINCT m.milestonetitle, ', '), '') AS milestones"
        )
      );

    // --- Filters ---
    if (milestoneTitle && milestoneTitle.trim() !== '') {
      baseQuery.whereILike('m.milestonetitle', `%${milestoneTitle.trim()}%`);
    }

    if (name && name.trim() !== '') {
      const lowerName = name.trim().toLowerCase();
      baseQuery.whereRaw(
        "LOWER(p.participantfirstname || ' ' || p.participantlastname) LIKE ?",
        [`%${lowerName}%`]
      );
    }

    if (email && email.trim() !== '') {
      baseQuery.whereILike('p.email', `%${email.trim()}%`);
    }

    if (phone && phone.trim() !== '') {
      baseQuery.whereILike('p.participantphone', `%${phone.trim()}%`);
    }

    // Same filters for total count
    const countQuery = knex('participants as p')
      .leftJoin('milestones as m', 'p.participantid', 'm.participantid')
      .modify((q) => {
        if (milestoneTitle && milestoneTitle.trim() !== '') {
          q.whereILike('m.milestonetitle', `%${milestoneTitle.trim()}%`);
        }
        if (name && name.trim() !== '') {
          const lowerName = name.trim().toLowerCase();
          q.whereRaw(
            "LOWER(p.participantfirstname || ' ' || p.participantlastname) LIKE ?",
            [`%${lowerName}%`]
          );
        }
        if (email && email.trim() !== '') {
          q.whereILike('p.email', `%${email.trim()}%`);
        }
        if (phone && phone.trim() !== '') {
          q.whereILike('p.participantphone', `%${phone.trim()}%`);
        }
      })
      .countDistinct('p.participantid as total');

    const [participants, totalResult] = await Promise.all([
      baseQuery.limit(pageSize).offset(offset),
      countQuery,
    ]);

    const total = parseInt(totalResult[0].total, 10) || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    console.log('Participants length:', participants.length);
    console.log('Filter milestoneTitle:', milestoneTitle);

    res.render('participants', {
      participants,
      error_message: '',
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,
      currentPage: page,
      totalPages,
      milestoneTitle: milestoneTitle || '',
      name: name || '',
      email: email || '',
      phone: phone || '',
    });
  } catch (error) {
    console.error('Error loading participants:', error);
    res.render('participants', {
      participants: [],
      error_message: `Database error: ${error.message}`,
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,
      currentPage: 1,
      totalPages: 1,
      milestoneTitle: milestoneTitle || '',
      name: name || '',
      email: email || '',
      phone: phone || '',
    });
  }
});

// Add new participant form (admin only)
app.get('/participants/add', (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'admin') {
    return res.render('login', { error_message: 'You do not have permission to add participants.' });
  }

  res.render('participant_add', {
    error_message: '',
    isAdmin: true,
    Username: req.session.username,
    csrfToken: req.csrfToken()
  });
});

// Create a new participant (admin only)
app.post('/participants/add', async (req, res) => {

  // Check login status
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }

  // Check admin role
  if (req.session.role !== 'admin') {
    return res.render('login', {
      error_message: 'You do not have permission to add participants.'
    });
  }

  // Extract form data
  const {
    email,
    participantfirstname,
    participantlastname,
    participantdob,
    participantrole,
    participantphone,
    participantcity,
    participantstate,
    participantzip,
    participantfieldofinterest
  } = req.body;

  try {
    // Insert into database
    await knex('participants').insert({
    email,
    participantfirstname,
    participantlastname,
    participantdob: participantdob || null,
    participantrole: participantrole || null,
    participantphone: participantphone || null,
    participantcity: participantcity || null,
    participantstate: participantstate || null,
    participantzip: participantzip || null,
    participantfieldofinterest: participantfieldofinterest || null
    });

    // Redirect after success
    return res.redirect('/participants');

  } catch (err) {
    console.error('Error inserting participant:', err);

    // Re-render the form with an error message
    return res.render('participant_add', {
      error_message: 'Error creating participant.',
      isAdmin: true,
      Username: req.session.username,
      csrfToken: req.csrfToken()
    });
  }
});

// View-only participant details page
app.get('/participants/:participantid', async (req, res) => {
  if (!req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }

  const participantid = parseInt(req.params.participantid, 10);

  if (Number.isNaN(participantid)) {
    return res.render('viewParticipant', {
      participant: null,
      events: [],
      milestones: [],
      surveys: [],
      donations: [],
      avgOverallScore: null,
      surveyCount: 0,
      firstRegistration: null,
      lastRegistration: null,
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,
      error_message: 'Invalid participant id.'
    });
  }

  try {
    // 1) Participant 基本情報 + Origin 情報
    const participant = await knex('participants as p')
      .leftJoin('origintypes as o', 'p.origintypepairid', 'o.origintypepairid')
      .where('p.participantid', participantid)
      .select(
        'p.*',
        'o.participantorigin',
        'o.participantorigintype'
      )
      .first();

    if (!participant) {
      console.error('Participant not found for id =', participantid);
      return res.render('viewParticipant', {
        participant: null,
        events: [],
        milestones: [],
        surveys: [],
        donations: [],
        avgOverallScore: null,
        surveyCount: 0,
        firstRegistration: null,
        lastRegistration: null,
        isAdmin: req.session.role === 'admin',
        Username: req.session.username,
        error_message: 'Participant not found.'
      });
    }

    // 2) Events + Registrations
    const events = await knex('registrations as r')
      .join('eventdetails as ed', 'r.eventdetailsid', 'ed.eventdetailsid')
      .join('events as e', 'ed.eventid', 'e.eventid')
      .where('r.participantid', participantid)
      .select(
        'e.eventname as eventtitle',
        'e.eventtype',
        'ed.eventdatetimestart',
        'r.registrationstatus',
        'r.registrationcheckintime',
        'r.registrationattendanceflag',
        'r.registrationcreatedat'
      )
      .orderBy('ed.eventdatetimestart', 'asc');

    // 3) Milestones
    const milestones = await knex('milestones')
      .where({ participantid })
      .orderBy('milestonedate', 'asc');

    // 4) Surveys (post) 一覧
    const surveys = await knex('surveys as s')
      .join('events as e', 's.eventid', 'e.eventid')
      .where('s.participantid', participantid)
      .select(
        's.surveyid',
        'e.eventname as eventtitle',
        's.eventdatetimestart',
        's.surveysatisfactionscore',
        's.surveyusefulnessscore',
        's.surveyinstructorscore',
        's.surveyrecommendationscore',
        's.surveyoverallscore',
        's.surveysubmissiondate'
      )
      .orderBy('s.surveysubmissiondate', 'asc');

    // 5) Survey 集計
    const surveyAgg = await knex('surveys')
      .where({ participantid })
      .avg({ avgOverallScore: 'surveyoverallscore' })
      .count({ surveyCount: '*' })
      .first();

    const avgOverallScore = surveyAgg && surveyAgg.avgOverallScore
      ? Number(surveyAgg.avgOverallScore)
      : null;
    const surveyCount = surveyAgg ? Number(surveyAgg.surveyCount) : 0;

    // 6) Registrations の最初・最後
    const regAgg = await knex('registrations')
      .where({ participantid })
      .min({ firstRegistration: 'registrationcreatedat' })
      .max({ lastRegistration: 'registrationcreatedat' })
      .first();

    const firstRegistration = regAgg ? regAgg.firstRegistration : null;
    const lastRegistration = regAgg ? regAgg.lastRegistration : null;

    // 7) Donations 一覧
    const donations = await knex('donations')
      .where({ participantid })
      .orderBy('donationdate', 'asc');

    console.log('View page loaded for participantid =', participantid);

    return res.render('viewParticipant', {
      participant,
      events,
      milestones,
      surveys,
      donations,
      avgOverallScore,
      surveyCount,
      firstRegistration,
      lastRegistration,
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,
      error_message: ''
    });
  } catch (err) {
    console.error('Error loading participant details:', err);
    return res.render('viewParticipant', {
      participant: null,
      events: [],
      milestones: [],
      surveys: [],
      donations: [],
      avgOverallScore: null,
      surveyCount: 0,
      firstRegistration: null,
      lastRegistration: null,
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,
      error_message: 'Error loading participant details.'
    });
  }
});

// Edit page: form + editable summary (admin only)
app.get('/participants/:participantid/edit', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }

  // Only admins can edit participants
  if (req.session.role !== 'admin') {
    return res.render('login', { error_message: 'You do not have permission to edit this participant.' });
  }

  const participantid = req.params.participantid;

  try {
    // 1) Participant basic info + origin info
    const participant = await knex('participants as p')
      .leftJoin('origintypes as o', 'p.origintypepairid', 'o.origintypepairid')
      .where('p.participantid', participantid)
      .select(
        'p.*',
        'o.participantorigin',
        'o.participantorigintype'
      )
      .first();

    if (!participant) {
      console.error('Edit: participant not found for id =', participantid);
      return res.render('participant_edit', {
        participant: null,
        events: [],
        milestones: [],
        surveys: [],
        donations: [],
        avgOverallScore: null,
        surveyCount: 0,
        firstRegistration: null,
        lastRegistration: null,
        csrfToken: req.csrfToken(),
        isAdmin: req.session.role === 'admin',
        Username: req.session.username,
        error_message: 'Participant not found.'
      });
    }

    // 2) Events + registrations (include registrationid for editing)
    const events = await knex('registrations as r')
      .join('eventdetails as ed', 'r.eventdetailsid', 'ed.eventdetailsid')
      .join('events as e', 'ed.eventid', 'e.eventid')
      .where('r.participantid', participantid)
      .select(
        'r.registrationid',
        'e.eventname as eventtitle',
        'e.eventtype',
        'ed.eventdatetimestart',
        'r.registrationstatus',
        'r.registrationcheckintime',
        'r.registrationattendanceflag',
        'r.registrationcreatedat'
      )
      .orderBy('ed.eventdatetimestart', 'asc');

    // 3) Milestones (include milestoneid for editing)
    const milestones = await knex('milestones')
    .where({ participantid })
    .select(
        'milestoneid',
        'milestonetitle',
        'milestonedate'
    )
    .orderBy('milestonedate', 'asc');

    // 4) Post-event surveys list (include surveyid for editing)
    const surveys = await knex('surveys as s')
      .join('events as e', 's.eventid', 'e.eventid')
      .where('s.participantid', participantid)
      .select(
        's.surveyid',
        'e.eventname as eventtitle',
        's.eventdatetimestart',
        's.surveysatisfactionscore',
        's.surveyusefulnessscore',
        's.surveyinstructorscore',
        's.surveyrecommendationscore',
        's.surveyoverallscore',
        's.surveysubmissiondate'
      )
      .orderBy('s.surveysubmissiondate', 'asc');

    // 5) Survey aggregate
    const surveyAgg = await knex('surveys')
      .where({ participantid })
      .avg({ avgOverallScore: 'surveyoverallscore' })
      .count({ surveyCount: '*' })
      .first();

    const avgOverallScore = surveyAgg && surveyAgg.avgOverallScore
      ? Number(surveyAgg.avgOverallScore)
      : null;
    const surveyCount = surveyAgg ? Number(surveyAgg.surveyCount) : 0;

    // 6) Earliest and latest registration timestamps
    const regAgg = await knex('registrations')
      .where({ participantid })
      .min({ firstRegistration: 'registrationcreatedat' })
      .max({ lastRegistration: 'registrationcreatedat' })
      .first();

    const firstRegistration = regAgg ? regAgg.firstRegistration : null;
    const lastRegistration = regAgg ? regAgg.lastRegistration : null;

    // 7) Donations list (include donationid for editing)
    const donations = await knex('donations')
      .where({ participantid })
      .select(
        'donationid',
        'donationdate',
        'donationamount'
      )
      .orderBy('donationdate', 'asc');

    console.log('Edit page loaded for participantid =', participantid);

    return res.render('participant_edit', {
      participant,
      events,
      milestones,
      surveys,
      donations,
      avgOverallScore,
      surveyCount,
      firstRegistration,
      lastRegistration,
      csrfToken: req.csrfToken(),
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,
      error_message: ''
    });
  } catch (err) {
    console.error('Error loading participant (edit route):', err);
    return res.render('participant_edit', {
      participant: null,
      events: [],
      milestones: [],
      surveys: [],
      donations: [],
      avgOverallScore: null,
      surveyCount: 0,
      firstRegistration: null,
      lastRegistration: null,
      csrfToken: req.csrfToken(),
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,
      error_message: 'Error loading participant for editing.'
    });
  }
});



//Update the participant information
app.post('/participants/:participantid/edit', (req, res) => {
    const participantid = req.params.participantid;

    const updated = {
        email: req.body.email,
        participantfirstname: req.body.participantfirstname,
        participantlastname: req.body.participantlastname,
        participantdob: req.body.participantdob,
        participantrole: req.body.participantrole,
        participantphone: req.body.participantphone,
        participantcity: req.body.participantcity,
        participantstate: req.body.participantstate,
        participantzip: req.body.participantzip,
        participantfieldofinterest: req.body.participantfieldofinterest
    };

    knex('participants')
        .where({ participantid })
        .update(updated)
        .then(() => res.redirect('/participants'))
        .catch(err => {
            console.error("Error updating participant:", err);
            res.send("Update error.");
        });
});


// Update a single survey row (post-event survey scores) for this participant
app.post('/participants/:participantid/surveys/:surveyid', async (req, res) => {
  const { participantid, surveyid } = req.params;

  const updated = {
    surveysatisfactionscore: req.body.surveysatisfactionscore || null,
    surveyusefulnessscore: req.body.surveyusefulnessscore || null,
    surveyinstructorscore: req.body.surveyinstructorscore || null,
    surveyrecommendationscore: req.body.surveyrecommendationscore || null,
    surveyoverallscore: req.body.surveyoverallscore || null
  };

  try {
    await knex('surveys')
      .where({ surveyid, participantid })
      .update(updated);

    return res.redirect(`/participants/${participantid}/edit`);
  } catch (err) {
    console.error('Error updating survey:', err);
    return res.status(500).send('Error updating survey.');
  }
});

// Update a single milestone for this participant
app.post('/participants/:participantid/milestones/:milestoneid', async (req, res) => {
  const { participantid, milestoneid } = req.params;

  const updated = {
    milestonetitle: req.body.milestonetitle || null,
    milestonedate: req.body.milestonedate || null
  };

  try {
    await knex('milestones')
      .where({ milestoneid, participantid })
      .update(updated);

    return res.redirect(`/participants/${participantid}/edit`);
  } catch (err) {
    console.error('Error updating milestone:', err);
    return res.status(500).send('Error updating milestone.');
  }
});

// Update a single donation for this participant
app.post('/participants/:participantid/donations/:donationid', async (req, res) => {
  const { participantid, donationid } = req.params;

  const updated = {
    donationdate: req.body.donationdate || null,
    donationamount: req.body.donationamount || null
  };

  try {
    await knex('donations')
      .where({ donationid, participantid })
      .update(updated);

    return res.redirect(`/participants/${participantid}/edit`);
  } catch (err) {
    console.error('Error updating donation:', err);
    return res.status(500).send('Error updating donation.');
  }
});




app.post('/deleteparticipants/:participantid', (req, res) => {
    // Get participant ID from URL parameter
    const participantid = req.params.participantid;

    knex('participants')
      // Delete the record matching this participant ID
      .where('participantid', participantid)
      .del()
      .then(() => {
        // After deleting, redirect back to the participants list
        res.redirect('/participants');
      })
      .catch(err => {
        // Log any database errors for debugging
        console.error(err);
        res.status(500).json({ err });
      });
});
// =========================
// Events list (search + paging)
// =========================
app.get('/events', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }

  const pageSize = 25;

  // Separate page numbers for upcoming / past
  const upcomingPage = parseInt(req.query.upcomingPage, 10) || 1;
  const pastPage = parseInt(req.query.pastPage, 10) || 1;

  const { name, startDate, endDate } = req.query;
  const now = new Date();

  // Helper: apply filters (name, startDate, endDate)
  function applyEventFilters(q) {
    if (name && name.trim() !== '') {
      q.whereILike('e.eventname', `%${name.trim()}%`);
    }
    if (startDate && startDate.trim() !== '') {
      // startDate is yyyy-mm-dd; compare as >= that date
      q.where('ed.eventdatetimestart', '>=', startDate);
    }
    if (endDate && endDate.trim() !== '') {
      // <= endDate end-of-day
      q.where('ed.eventdatetimestart', '<', new Date(endDate + 'T23:59:59'));
    }
  }

  // Base select clause (used for both upcoming / past)
  function baseSelect(q) {
    return q
      .select(
        'ed.eventdetailsid',
        'e.eventid',
        'e.eventname',
        'e.eventdescription',
        'ed.eventdatetimestart',
        'ed.eventdatetimeend',
        'ed.eventlocation',
        'ed.eventcapacity',
        'ed.eventregistrationdeadline',
        // number of registrations
        knex.raw('COUNT(r.registrationid) AS registeredcount'),
        // number of attendees (attendance flag true)
        knex.raw(
          "COALESCE(SUM(CASE WHEN r.registrationattendanceflag = true THEN 1 ELSE 0 END), 0) AS attendedcount"
        )
      )
      .groupBy(
        'ed.eventdetailsid',
        'e.eventid',
        'e.eventname',
        'e.eventdescription',
        'ed.eventdatetimestart',
        'ed.eventdatetimeend',
        'ed.eventlocation',
        'ed.eventcapacity',
        'ed.eventregistrationdeadline'
      );
  }

  // Build upcoming events query
  function buildUpcomingQuery() {
    const q = knex('eventdetails as ed')
      .join('events as e', 'ed.eventid', 'e.eventid')
      .leftJoin('registrations as r', 'r.eventdetailsid', 'ed.eventdetailsid');
    applyEventFilters(q);
    q.where('ed.eventdatetimestart', '>=', now);
    q.orderBy('ed.eventdatetimestart', 'asc');
    return baseSelect(q);
  }

  // Build past events query
  function buildPastQuery() {
    const q = knex('eventdetails as ed')
      .join('events as e', 'ed.eventid', 'e.eventid')
      .leftJoin('registrations as r', 'r.eventdetailsid', 'ed.eventdetailsid');
    applyEventFilters(q);
    q.where('ed.eventdatetimestart', '<', now);
    q.orderBy('ed.eventdatetimestart', 'desc');
    return baseSelect(q);
  }

  try {
    const upcomingOffset = (upcomingPage - 1) * pageSize;
    const pastOffset = (pastPage - 1) * pageSize;

    const [
      upcomingEvents,
      upcomingCountRows,
      pastEvents,
      pastCountRows
    ] = await Promise.all([
      buildUpcomingQuery().limit(pageSize).offset(upcomingOffset),
      // count distinct eventdetailsid for upcoming
      (function () {
        const q = knex('eventdetails as ed')
          .join('events as e', 'ed.eventid', 'e.eventid');
        applyEventFilters(q);
        q.where('ed.eventdatetimestart', '>=', now);
        return q.countDistinct('ed.eventdetailsid as total');
      })(),
      buildPastQuery().limit(pageSize).offset(pastOffset),
      // count distinct eventdetailsid for past
      (function () {
        const q = knex('eventdetails as ed')
          .join('events as e', 'ed.eventid', 'e.eventid');
        applyEventFilters(q);
        q.where('ed.eventdatetimestart', '<', now);
        return q.countDistinct('ed.eventdetailsid as total');
      })()
    ]);

    const upcomingTotal =
      upcomingCountRows && upcomingCountRows.length > 0
        ? parseInt(upcomingCountRows[0].total, 10) || 0
        : 0;
    const pastTotal =
      pastCountRows && pastCountRows.length > 0
        ? parseInt(pastCountRows[0].total, 10) || 0
        : 0;

    const upcomingTotalPages = Math.max(
      1,
      Math.ceil(upcomingTotal / pageSize)
    );
    const pastTotalPages = Math.max(1, Math.ceil(pastTotal / pageSize));

    return res.render('events', {
      error_message: '',
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,

      name: name || '',
      startDate: startDate || '',
      endDate: endDate || '',

      upcomingEvents,
      upcomingCurrentPage: upcomingPage,
      upcomingTotalPages,

      pastEvents,
      pastCurrentPage: pastPage,
      pastTotalPages
    });
  } catch (err) {
    console.error('Error loading events:', err);
    return res.render('events', {
      error_message: 'Error loading events.',
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,

      name: name || '',
      startDate: startDate || '',
      endDate: endDate || '',

      upcomingEvents: [],
      upcomingCurrentPage: 1,
      upcomingTotalPages: 1,

      pastEvents: [],
      pastCurrentPage: 1,
      pastTotalPages: 1
    });
  }
});

// Show edit form for an eventdetail (manager only)
app.get('/events/:eventdetailsid/edit', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'admin') {
    return res.render('login', { error_message: 'You do not have permission to edit events.' });
  }

  const { eventdetailsid } = req.params;

  try {
    const event = await knex('eventdetails as ed')
      .join('events as e', 'ed.eventid', 'e.eventid')
      .where('ed.eventdetailsid', eventdetailsid)
      .select(
        'ed.eventdetailsid',
        'e.eventid',
        'e.eventname',
        'e.eventtype', 
        'e.eventdescription',
        'ed.eventdatetimestart',
        'ed.eventdatetimeend',
        'ed.eventlocation',
        'ed.eventcapacity',
        'ed.eventregistrationdeadline'
      )
      .first();

    if (!event) {
      return res.send('Event not found.');
    }

    res.render('event_edit', {
      event,
      error_message: '',
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    console.error('Error loading event for edit:', err);
    res.send('Error loading event for edit.');
  }
});

// Update event (manager only)
app.post('/events/:eventdetailsid/edit', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'admin') {
    return res.render('login', { error_message: 'You do not have permission to edit events.' });
  }

  const { eventdetailsid } = req.params;
  const {
    eventname,
    eventtype,
    eventdescription,
    eventdatetimestart,
    eventdatetimeend,
    eventlocation,
    eventcapacity,
    eventregistrationdeadline
  } = req.body;

  try {
    await knex.transaction(async (trx) => {
      const detailRow = await trx('eventdetails')
        .where({ eventdetailsid })
        .select('eventid')
        .first();

      if (!detailRow) {
        throw new Error('Event not found.');
      }

      const eventid = detailRow.eventid;

      await trx('events')
        .where({ eventid })
        .update({
          eventname,
          eventtype,
          eventdescription
        });

      await trx('eventdetails')
        .where({ eventdetailsid })
        .update({
          eventdatetimestart,
          eventdatetimeend,
          eventlocation,
          eventcapacity,
          eventregistrationdeadline
        });
    });

    res.redirect('/events');
  } catch (err) {
    console.error('Error updating event:', err);
    res.send('Error updating event.');
  }
});

// Delete eventdetail (manager only)
app.post('/events/:eventdetailsid/delete', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'admin') {
    return res.render('login', { error_message: 'You do not have permission to delete events.' });
  }

  const { eventdetailsid } = req.params;

  try {
    await knex.transaction(async (trx) => {
      // Delete registrations for this eventdetail first (to avoid FK issues)
      await trx('registrations')
        .where({ eventdetailsid })
        .del();

      // Then delete eventdetails row
      await trx('eventdetails')
        .where({ eventdetailsid })
        .del();
    });

    res.redirect('/events');
  } catch (err) {
    console.error('Error deleting event:', err);
    res.send('Error deleting event.');
  }
});

// ===============================
// Surveys - list (search + paging)
// ===============================
app.get('/surveys', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }

  const pageSize = 25;
  const page = parseInt(req.query.page, 10) || 1;
  const offset = (page - 1) * pageSize;

  const eventName = req.query.eventName ? req.query.eventName.trim() : '';
  const participantName = req.query.participantName ? req.query.participantName.trim() : '';

  const rawStartDate = req.query.startDate || '';
  const rawEndDate   = req.query.endDate || '';
  const startDate = rawStartDate.trim();
  const endDate   = rawEndDate.trim();

  try {

    // ============================
    // 🚀 Base query with JOINs
    // ============================
    const baseQuery = knex('surveys as s')
      .join('events as e', 's.eventid', 'e.eventid')
      .join('participants as p', 's.participantid', 'p.participantid')
      .join('eventdetails as ed', function () {
        this.on('ed.eventid', '=', 's.eventid')
            .andOn('ed.eventdatetimestart', '=', 's.eventdatetimestart');
      })
      .select(
        's.surveyid',
        'e.eventname',
        's.eventdatetimestart',
        'ed.eventlocation',             // ← now valid!
        'p.participantfirstname',
        'p.participantlastname',
        's.surveysatisfactionscore',
        's.surveyusefulnessscore',
        's.surveyinstructorscore',
        's.surveyrecommendationscore',
        's.surveyoverallscore',
        's.surveysubmissiondate'
      );

    // ============================
    // Filters
    // ============================
    if (eventName !== '') {
      baseQuery.whereILike('e.eventname', `%${eventName}%`);
    }

    if (participantName !== '') {
      const lowerName = participantName.toLowerCase();
      baseQuery.whereRaw(
        "LOWER(p.participantfirstname || ' ' || p.participantlastname) LIKE ?",
        [`%${lowerName}%`]
      );
    }

    if (startDate !== '') {
      baseQuery.where('s.surveysubmissiondate', '>=', startDate);
    }
    if (endDate !== '') {
      baseQuery.where('s.surveysubmissiondate', '<=', endDate);
    }


    // ============================
    // Count query also needs JOIN!
    // ============================
    const countQuery = knex('surveys as s')
      .join('events as e', 's.eventid', 'e.eventid')
      .join('participants as p', 's.participantid', 'p.participantid')
      .join('eventdetails as ed', function () {
        this.on('ed.eventid', '=', 's.eventid')
            .andOn('ed.eventdatetimestart', '=', 's.eventdatetimestart');
      })
      .modify((q) => {
        if (eventName !== '') {
          q.whereILike('e.eventname', `%${eventName}%`);
        }
        if (participantName !== '') {
          const lowerName = participantName.toLowerCase();
          q.whereRaw(
            "LOWER(p.participantfirstname || ' ' || p.participantlastname) LIKE ?",
            [`%${lowerName}%`]
          );
        }
        if (startDate !== '') {
          q.where('s.surveysubmissiondate', '>=', startDate);
        }
        if (endDate !== '') {
          q.where('s.surveysubmissiondate', '<=', endDate);
        }
      })
      .countDistinct('s.surveyid as total');


    // ============================
    // Execute the queries
    // ============================
    const [surveys, totalResult] = await Promise.all([
      baseQuery
        .orderBy('s.surveysubmissiondate', 'desc')
        .limit(pageSize)
        .offset(offset),

      countQuery
    ]);

    const total = parseInt(totalResult[0].total, 10) || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return res.render('survey', {
      surveys,
      error_message: '',
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,
      eventName,
      participantName,
      startDate,
      endDate,
      currentPage: page,
      totalPages
    });

  } catch (err) {
    console.error('Error loading surveys:', err);
    return res.render('survey', {
      surveys: [],
      error_message: 'Error loading surveys.',
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,
      eventName,
      participantName,
      startDate,
      endDate,
      currentPage: 1,
      totalPages: 1
    });
  }
});


// =======================================
// Survey - show "new survey" form (admin)
// =======================================
app.get('/surveys/new', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'admin') {
    return res.render('login', {
      error_message: 'You do not have permission to add surveys.'
    });
  }

  try {
    // For simplicity we just load basic lists
    const events = await knex('events')
      .select('eventid', 'eventname')
      .orderBy('eventname', 'asc');

    const participants = await knex('participants')
      .select('participantid', 'participantfirstname', 'participantlastname', 'email')
      .orderBy('participantlastname', 'asc');

    return res.render('survey_new', {
      events,
      participants,
      error_message: '',
      isAdmin: true,
      Username: req.session.username,
      // csrfToken is already in res.locals
    });
  } catch (err) {
    console.error('Error loading data for new survey:', err);
    return res.render('survey_new', {
      events: [],
      participants: [],
      error_message: 'Error loading data for new survey.',
      isAdmin: true,
      Username: req.session.username
    });
  }
});

// =====================================
// Survey - create new survey (admin)
// =====================================
app.post('/surveys/new', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'admin') {
    return res.render('login', {
      error_message: 'You do not have permission to add surveys.'
    });
  }

  const {
    participantid,
    eventid,
    eventdatetimestart,
    surveysatisfactionscore,
    surveyusefulnessscore,
    surveyinstructorscore,
    surveyrecommendationscore,
    surveyoverallscore,
    surveysubmissiondate
  } = req.body;

  try {
    // Optional: auto-calc overall if not provided
    let overall = surveyoverallscore;
    if (
      (!overall || overall === '') &&
      surveysatisfactionscore &&
      surveyusefulnessscore &&
      surveyinstructorscore &&
      surveyrecommendationscore
    ) {
      const vals = [
        Number(surveysatisfactionscore),
        Number(surveyusefulnessscore),
        Number(surveyinstructorscore),
        Number(surveyrecommendationscore)
      ];
      const sum = vals.reduce((acc, v) => acc + (isNaN(v) ? 0 : v), 0);
      const count = vals.filter(v => !isNaN(v)).length;
      if (count > 0) {
        overall = (sum / count).toFixed(2);
      }
    }

    await knex('surveys').insert({
      participantid,
      eventid,
      eventdatetimestart: eventdatetimestart || null,
      surveysatisfactionscore: surveysatisfactionscore || null,
      surveyusefulnessscore: surveyusefulnessscore || null,
      surveyinstructorscore: surveyinstructorscore || null,
      surveyrecommendationscore: surveyrecommendationscore || null,
      surveyoverallscore: overall || null,
      surveysubmissiondate: surveysubmissiondate || knex.fn.now()
    });

    return res.redirect('/surveys');
  } catch (err) {
    console.error('Error inserting new survey:', err);
    // You might want to reload lists and show error, but simple redirect is ok
    return res.render('survey_new', {
      events: [],
      participants: [],
      error_message: 'Error inserting new survey.',
      isAdmin: true,
      Username: req.session.username
    });
  }
});


// =====================================
// Survey - show edit form (admin only)
// =====================================
app.get('/surveys/:surveyid/edit', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'admin') {
    return res.render('login', {
      error_message: 'You do not have permission to edit surveys.'
    });
  }

  const { surveyid } = req.params;

  try {
    const survey = await knex('surveys as s')
      .join('events as e', 's.eventid', 'e.eventid')
      .join('participants as p', 's.participantid', 'p.participantid')
      .where('s.surveyid', surveyid)
      .select(
        's.surveyid',
        's.participantid',
        's.eventid',
        's.eventdatetimestart',
        's.surveysatisfactionscore',
        's.surveyusefulnessscore',
        's.surveyinstructorscore',
        's.surveyrecommendationscore',
        's.surveyoverallscore',
        's.surveysubmissiondate',
        'e.eventname',
        'p.participantfirstname',
        'p.participantlastname',
        'p.email'
      )
      .first();

    if (!survey) {
      return res.send('Survey not found.');
    }

    return res.render('survey_edit', {
      survey,
      error_message: '',
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,
      csrfToken: req.csrfToken()  
    });
  } catch (err) {
    console.error('Error loading survey for edit:', err);
    return res.send('Error loading survey for edit.');
  }
});


// =====================================
// Survey - update existing survey (admin)
// =====================================
app.post('/surveys/:surveyid/edit', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'admin') {
    return res.render('login', {
      error_message: 'You do not have permission to edit surveys.'
    });
  }

  const { surveyid } = req.params;
  const {
    surveysatisfactionscore,
    surveyusefulnessscore,
    surveyinstructorscore,
    surveyrecommendationscore,
    surveyoverallscore,
    surveysubmissiondate
  } = req.body;

  try {
    let overall = surveyoverallscore;
    if (
      (!overall || overall === '') &&
      surveysatisfactionscore &&
      surveyusefulnessscore &&
      surveyinstructorscore &&
      surveyrecommendationscore
    ) {
      const vals = [
        Number(surveysatisfactionscore),
        Number(surveyusefulnessscore),
        Number(surveyinstructorscore),
        Number(surveyrecommendationscore)
      ];
      const sum = vals.reduce((acc, v) => acc + (isNaN(v) ? 0 : v), 0);
      const count = vals.filter(v => !isNaN(v)).length;
      if (count > 0) {
        overall = (sum / count).toFixed(2);
      }
    }

    await knex('surveys')
      .where({ surveyid })
      .update({
        surveysatisfactionscore: surveysatisfactionscore || null,
        surveyusefulnessscore: surveyusefulnessscore || null,
        surveyinstructorscore: surveyinstructorscore || null,
        surveyrecommendationscore: surveyrecommendationscore || null,
        surveyoverallscore: overall || null,
        surveysubmissiondate: surveysubmissiondate || null
      });

    return res.redirect('/surveys');
  } catch (err) {
    console.error('Error updating survey:', err);
    return res.send('Error updating survey.');
  }
});


// =====================================
// Survey - delete (admin only)
// =====================================
app.post('/surveys/:surveyid/delete', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'admin') {
    return res.render('login', {
      error_message: 'You do not have permission to delete surveys.'
    });
  }

  const { surveyid } = req.params;

  try {
    await knex('surveys')
      .where({ surveyid })
      .del();

    return res.redirect('/surveys');
  } catch (err) {
    console.error('Error deleting survey:', err);
    return res.send('Error deleting survey.');
  }
});

// =====================================
// Milestones - list (logged-in users)
// =====================================
app.get('/milestones', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }

  const pageSize = 25;
  const page = parseInt(req.query.page, 10) || 1;
  const offset = (page - 1) * pageSize;

  const participantName = req.query.participantName ? req.query.participantName.trim() : '';
  const email = req.query.email ? req.query.email.trim() : '';
  const milestoneTitle = req.query.milestoneTitle ? req.query.milestoneTitle.trim() : '';
  const startDate = req.query.startDate || '';
  const endDate = req.query.endDate || '';

  try {
    // Base query
    const baseQuery = knex('milestones as m')
      .join('participants as p', 'm.participantid', 'p.participantid')
      .select(
        'm.milestoneid',
        'm.milestonetitle',
        'm.milestonedate',
        'p.participantid',
        'p.participantfirstname',
        'p.participantlastname',
        'p.email'
      );

    if (participantName !== '') {
      const lower = participantName.toLowerCase();
      baseQuery.whereRaw(
        "LOWER(p.participantfirstname || ' ' || p.participantlastname) LIKE ?",
        [`%${lower}%`]
      );
    }

    if (email !== '') {
      baseQuery.whereILike('p.email', `%${email}%`);
    }

    if (milestoneTitle !== '') {
      baseQuery.whereILike('m.milestonetitle', `%${milestoneTitle}%`);
    }

    if (startDate !== '') {
      baseQuery.where('m.milestonedate', '>=', startDate);
    }
    if (endDate !== '') {
      baseQuery.where('m.milestonedate', '<=', endDate);
    }

    const countQuery = knex('milestones as m')
      .join('participants as p', 'm.participantid', 'p.participantid')
      .modify((q) => {
        if (participantName !== '') {
          const lower = participantName.toLowerCase();
          q.whereRaw(
            "LOWER(p.participantfirstname || ' ' || p.participantlastname) LIKE ?",
            [`%${lower}%`]
          );
        }
        if (email !== '') {
          q.whereILike('p.email', `%${email}%`);
        }
        if (milestoneTitle !== '') {
          q.whereILike('m.milestonetitle', `%${milestoneTitle}%`);
        }
        if (startDate !== '') {
          q.where('m.milestonedate', '>=', startDate);
        }
        if (endDate !== '') {
          q.where('m.milestonedate', '<=', endDate);
        }
      })
      .countDistinct('m.milestoneid as total');

    const [milestones, totalResult] = await Promise.all([
      baseQuery
        .orderBy('m.milestonedate', 'desc')
        .limit(pageSize)
        .offset(offset),
      countQuery
    ]);

    const total = parseInt(totalResult[0].total, 10) || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return res.render('milestones', {
      milestones,
      error_message: '',
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,
      participantName,
      email,
      milestoneTitle,
      startDate,
      endDate,
      currentPage: page,
      totalPages,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    console.error('Error loading milestones:', err);
    return res.render('milestones', {
      milestones: [],
      error_message: 'Error loading milestones.',
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,
      participantName,
      email,
      milestoneTitle,
      startDate,
      endDate,
      currentPage: 1,
      totalPages: 1,
      csrfToken: req.csrfToken()
    });
  }
});



// =====================================
// Milestones - new (admin only, GET)
// =====================================
app.get('/milestones/new', (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'admin') {
    return res.render('login', {
      error_message: 'You do not have permission to add milestones.'
    });
  }

  const prefillEmail = req.query.email || '';

  return res.render('milestones_new', {
    email: prefillEmail,
    milestonetitle: '',
    milestonedate: '',
    error_message: '',
    isAdmin: true,
    Username: req.session.username,
    csrfToken: req.csrfToken()
  });
});



// =====================================
// Milestones - create (admin only, POST)
// =====================================
app.post('/milestones/new', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'admin') {
    return res.render('login', {
      error_message: 'You do not have permission to add milestones.'
    });
  }

  const { email, milestonetitle, milestonedate } = req.body;

  try {
    const participant = await knex('participants')
      .whereILike('email', email.trim())
      .first();

    if (!participant) {
      return res.render('milestones_new', {
        email,
        milestonetitle,
        milestonedate,
        error_message: 'No participant found with that email.',
        isAdmin: true,
        Username: req.session.username,
        csrfToken: req.csrfToken()
      });
    }

    await knex('milestones').insert({
      participantid: participant.participantid,
      milestonetitle: milestonetitle || null,
      milestonedate: milestonedate || null
    });

    return res.redirect('/milestones');
  } catch (err) {
    console.error('Error creating milestone:', err);
    return res.render('milestones_new', {
      email,
      milestonetitle,
      milestonedate,
      error_message: 'Error creating milestone.',
      isAdmin: true,
      Username: req.session.username,
      csrfToken: req.csrfToken()
    });
  }
});



app.get('/milestones/:milestoneid/edit', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'admin') {
    return res.render('login', {
      error_message: 'You do not have permission to edit milestones.'
    });
  }

  const { milestoneid } = req.params;

  try {
    const milestone = await knex('milestones as m')
      .join('participants as p', 'm.participantid', 'p.participantid')
      .where('m.milestoneid', milestoneid)
      .select(
        'm.milestoneid',
        'm.milestonetitle',
        'm.milestonedate',
        'm.participantid',           
        'p.participantfirstname',
        'p.participantlastname',
        'p.email'
      )
      .first();

    
    const participants = await knex('participants')
      .select(
        'participantid',
        'participantfirstname',
        'participantlastname',
        'email'
      )
      .orderBy('participantlastname', 'asc')
      .orderBy('participantfirstname', 'asc');

    return res.render('milestones_edit', {
      milestone,
      participants,                      
      error_message: milestone ? '' : 'Milestone not found.',
      isAdmin: true,
      Username: req.session.username,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    console.error('Error loading milestone for edit:', err);
    return res.render('milestones_edit', {
      milestone: null,
      participants: [],              
      error_message: 'Error loading milestone for edit.',
      isAdmin: true,
      Username: req.session.username,
      csrfToken: req.csrfToken()
    });
  }
});


// =====================================
// Milestones - update (admin only, POST)
// =====================================
app.post('/milestones/:milestoneid/edit', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'admin') {
    return res.render('login', {
      error_message: 'You do not have permission to edit milestones.'
    });
  }

  const { milestoneid } = req.params;
  const { milestonetitle, milestonedate } = req.body;

  try {
    await knex('milestones')
      .where({ milestoneid })
      .update({
        milestonetitle: milestonetitle || null,
        milestonedate: milestonedate || null
      });

    return res.redirect('/milestones');
  } catch (err) {
    console.error('Error updating milestone:', err);
    // 再度編集画面を出したい場合は、もう一度 SELECT しても良いけど、
    // ここではシンプルにメッセージだけ返す
    return res.send('Error updating milestone.');
  }
});

// =====================================
// Milestones - delete (admin only, POST)
// =====================================
app.post('/milestones/:milestoneid/delete', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'admin') {
    return res.render('login', {
      error_message: 'You do not have permission to delete milestones.'
    });
  }

  const { milestoneid } = req.params;

  try {
    await knex('milestones')
      .where({ milestoneid })
      .del();

    return res.redirect('/milestones');
  } catch (err) {
    console.error('Error deleting milestone:', err);
    return res.send('Error deleting milestone.');
  }
});





app.listen(port, () => {
    console.log("The server is listening");
    console.log(`Server running on http://localhost:${port}`);
})