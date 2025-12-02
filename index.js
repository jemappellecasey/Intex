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
    if (req.session.isLoggedIn && req.session.role === 'A') {
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

});

app.get('/participants', (req, res) => {
    if (!req.session.isLoggedIn) {
        return res.render('login', { error_message: null });
    }

    knex
        .select('*')
        .from('participants')
        .then(participants => {
            res.render('participants', {
                participants,
                error_message: '',
                isManager: req.session.role === 'A',
                Username: req.session.username

            });
        })

        
        .catch(error => {
            console.error('Error loading users for dashboard:', error);
            res.render('participants', {
                participants: [],
                error_message: `Database error: ${error.message}`,
                isManager: req.session.role === 'A'
            });
        });


});

//app.get('/participants/:id', ...)
//app.get('/participants/:id/edit', ...)
//app.post('/participants/:id/delete', ...)

app.listen(port, () => {
    console.log("The server is listening");
    console.log(`Server running on http://localhost:${port}`);
})