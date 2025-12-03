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

  const pageSize = 25;  // Number of participants per page
  let page = parseInt(req.query.page, 10) || 1;  // Start at page 1 by default

  // Prevent invalid page numbers (negative or zero)
  if (page < 1) page = 1;

  try {
    // --- Step 1: Count total number of participants ---
    const totalResult = await knex('participants')
      .count('* as total');

    const total = parseInt(totalResult[0].total, 10);
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);

    // If the page number is too large, set it to the last page
    if (page > totalPages) page = totalPages;

    // --- Step 2: Calculate OFFSET for SQL query ---
    const offset = (page - 1) * pageSize;

    // --- Step 3: Fetch participants for the selected page ---
    const participants = await knex('participants')
      .select('*')
      .limit(pageSize)
      .offset(offset);

    console.log(`participants length (page ${page}):`, participants.length);

    // --- Step 4: Render the page with pagination values ---
    res.render('participants', {
      participants,
      error_message: '',
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,
      currentPage: page,
      totalPages
    });

  } catch (error) {
    console.error('Error loading participants:', error);

    // Render error page if something goes wrong
    res.render('participants', {
      participants: [],
      error_message: `Database error: ${error.message}`,
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,
      currentPage: 1,
      totalPages: 1
    });
  }
});


// View a single participant (details page)
app.get('/participants/:participantid', async (req, res) => {
  if (!req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }

  const participantid = req.params.participantid;

  try {
    const participant = await knex('participants')
      .where({ participantid })
      .first();

    if (!participant) {
      return res.render('participants', {
        participants: [],
        error_message: 'Participant not found.',
        isAdmin: req.session.role === 'admin',
        Username: req.session.username,
        currentPage: 1,
        totalPages: 1
      });
    }

    // Later: join events / surveys / milestones / donations here

    res.render('veiwParticipant', {
      participant,
    });
  } catch (err) {
    console.error('Error loading participant details:', err);
    res.render('participants', {
      participants: [],
      error_message: 'Error loading participant details.',
      isAdmin: req.session.role === 'admin',
      Username: req.session.username,
      currentPage: 1,
      totalPages: 1
    });
  }
});


//get the edit pages to edit the participant
app.get('/participants/:participantid/edit', (req, res) => {
    const participantid = req.params.participantid;

    knex('participants')
        .where({ participantid })
        .first()
        .then(p => {
            if (!p) {
                return res.send("Participant not found.");
            }

            res.render('participant_edit', {
                participant: p,
                csrfToken: req.csrfToken(),
                isAdmin: req.session.role === 'admin',
                Username: req.session.username
            });
        })
        .catch(err => {
            console.error("Error loading participant:", err);
            res.send("Error loading participant.");
        });
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