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
            return res.render('login', { error_message: 'Invalid Login' });
        }

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

// View-only participant details page
app.get('/participants/:participantid', async (req, res) => {
  if (!req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }

  const participantid = req.params.participantid;

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

// Edit page: form + read-only summary (admin only)
app.get('/participants/:participantid/edit', async (req, res) => {
  if (!req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }

  if (req.session.role !== 'admin') {
    return res.render('login', { error_message: 'You do not have permission to edit this participant.' });
  }

  const participantid = req.params.participantid;

  try {
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
      return res.send('Participant not found.');
    }

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

    const milestones = await knex('milestones')
      .where({ participantid })
      .orderBy('milestonedate', 'asc');

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

    const surveyAgg = await knex('surveys')
      .where({ participantid })
      .avg({ avgOverallScore: 'surveyoverallscore' })
      .count({ surveyCount: '*' })
      .first();

    const avgOverallScore = surveyAgg && surveyAgg.avgOverallScore
      ? Number(surveyAgg.avgOverallScore)
      : null;
    const surveyCount = surveyAgg ? Number(surveyAgg.surveyCount) : 0;

    const regAgg = await knex('registrations')
      .where({ participantid })
      .min({ firstRegistration: 'registrationcreatedat' })
      .max({ lastRegistration: 'registrationcreatedat' })
      .first();

    const firstRegistration = regAgg ? regAgg.firstRegistration : null;
    const lastRegistration = regAgg ? regAgg.lastRegistration : null;

    const donations = await knex('donations')
      .where({ participantid })
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
    return res.send('Error loading participant.');
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


app.listen(port, () => {
    console.log("The server is listening");
    console.log(`Server running on http://localhost:${port}`);
})