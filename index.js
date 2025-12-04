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

const crypto = require("crypto");
const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");

const sesClient = new SESv2Client({
  region: process.env.AWS_REGION || "us-east-1",
});

const transporter = nodemailer.createTransport({
  SES: { sesClient, SendEmailCommand },
});



//We need to fix it before deploying the AWS!!
const knex = require("knex")({
    client: "pg",
    connection: {
        host : process.env.DB_HOST || "localhost",
        user : process.env.DB_USER || "postgres",
        password : process.env.DB_PASSWORD || "manager",
        database : process.env.DB_NAME || "312intex",
        port : process.env.DB_PORT || 5432
    }
});
const app = express();
const port = process.env.PORT || 3000;

const multer = require('multer');
const uploadRoot = path.join(__dirname, "images");
const uploadDir = uploadRoot; // or path.join(uploadRoot, "uploads")
const storage = multer.diskStorage({
    destination: function(req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function(req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

app.set("view engine", "ejs");

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/images", express.static(path.join(__dirname, "images")));



//this is secrity section for the external link. If you want to use tableau, 
//or link, come to here to allow them.
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
    secret: process.env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: false,
  })
);

app.use(flash());

app.use((req, res, next) => {
  res.locals.error = req.flash("error");
  res.locals.info = req.flash("info");
  res.locals.success = req.flash("success");
  next();
});

const csrfProtection = csrf();
app.use(csrfProtection);


  
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
        const openPaths = ['/', '/login', '/logout', '/dev-login-bypass', '/signup', '/landing'];
        if (openPaths.includes(req.path)) {
          return next();
        }
        if (req.session.isLoggedIn) {
          return next();
        }
      else{
          res.render('login', {error_message: 'Please log in the access this page'})
      }
  });
  
async function ensureParticipantId(req) {
  if (!req.session || !req.session.isLoggedIn || !req.session.userId) {
    return null;
  }

  // Already present and valid
  if (req.session.participantId && !Number.isNaN(parseInt(req.session.participantId, 10))) {
    return parseInt(req.session.participantId, 10);
  }

  try {
    const hasColumn = await ensureUsersHasParticipantIdColumn();
    let participantId = null;

    if (hasColumn) {
      const userRow = await knex("users")
        .select("participantid")
        .where("userid", req.session.userId)
        .first();
      participantId = userRow && userRow.participantid;
    }

    if (!participantId) {
      const email =
        (req.session.username && req.session.username.trim().toLowerCase()) ||
        (await knex("users")
          .where("userid", req.session.userId)
          .first()
          .then((u) => (u && u.email ? u.email.trim().toLowerCase() : null))
          .catch(() => null));

      if (email) {
        const participant = await knex("participants")
          .whereILike("email", email)
          .first();
        participantId = participant ? participant.participantid : null;
      }
    }

    if (participantId) {
      const pid = parseInt(participantId, 10);
      if (!Number.isNaN(pid)) {
        req.session.participantId = pid;
        return pid;
      }
    }
  } catch (err) {
    console.error("Error reloading participantid for user", err);
  }
  return null;
}

// Check once whether users.participantid exists to avoid schema errors.
let usersHasParticipantIdColumn = null;
async function ensureUsersHasParticipantIdColumn() {
  if (usersHasParticipantIdColumn !== null) {
    return usersHasParticipantIdColumn;
  }
  try {
    usersHasParticipantIdColumn = await knex.schema.hasColumn("users", "participantid");
  } catch (err) {
    console.error("Error checking users.participantid column", err);
    usersHasParticipantIdColumn = false;
  }
  return usersHasParticipantIdColumn;
}

// Ensure the session has a participantId; create/link one if missing.
async function syncParticipantSession(req, user) {
  if (!req.session || !user) {
    return null;
  }

  let participantId = user.participantid;

  try {
    const normalizedEmail = (user.email || "").trim().toLowerCase();

    if (!participantId && normalizedEmail) {
      const existingParticipant = await knex("participants")
        .whereILike("email", normalizedEmail)
        .first();

      if (existingParticipant) {
        participantId = existingParticipant.participantid;
      } else {
        const [newParticipant] = await knex("participants")
          .insert({
            email: normalizedEmail,
            participantfirstname: "",
            participantlastname: "",
            participantrole: "participant",
          })
          .returning("participantid");

        participantId = newParticipant.participantid;
      }
    }

    if (participantId) {
      const pid = parseInt(participantId, 10);
      if (!Number.isNaN(pid)) {
        req.session.participantId = pid;
        const hasColumn = await ensureUsersHasParticipantIdColumn();
        if (user.userid && hasColumn) {
          await knex("users")
            .where({ userid: user.userid })
            .update({ participantid: pid });
        }
        return pid;
      }
    }
  } catch (err) {
    console.error("Error syncing participant session", err);
  }

  req.session.participantId = null;
  return null;
}

  
  
  //This is security for website if the user are manager or not.
  function requireManager(req, res, next) {
      if (req.session.isLoggedIn && req.session.role === 'manager') {
          return next();
      }
      return res.render('login', { error_message: 'You do not have permission to view this page.' });
  }
  

const sr = 10;

app.get("/signup", (req, res) => {
  res.render("signup", {
    csrfToken: req.csrfToken(),
    error: [],
    info: [],
    success: []
  });
});

app.post("/signup", async (req, res) => {
  const { email, password, first, last, phone, city, state, zip } = req.body;

  const renderError = (msg) => {
    return res.render("signup", {
      csrfToken: req.csrfToken(),
      error: [msg],
      info: [],
      success: []
    });
  };

  if (!email || !password || !first || !last) {
    return renderError("Email, password, first name, and last name are required.");
  }

  try {
    const normalizedEmail = email.trim().toLowerCase();
    const firstName = first.trim();
    const lastName = last.trim();

    // 1) Check for existing user account
    const existing = await knex("users")
      .where({ email: normalizedEmail })
      .first();

    if (existing) {
      return renderError("An account with that email already exists.");
    }

    // 2) Hash password
    const SALT_ROUNDS = 10;
    const hash = await bcrypt.hash(password, SALT_ROUNDS);

    // 3) Find or create participant for this email
    const existingParticipant = await knex("participants")
      .where({ email: normalizedEmail })
      .first();

    let participantId;

    if (existingParticipant) {
      participantId = existingParticipant.participantid;
    } else {
      const [newParticipant] = await knex("participants")
        .insert({
          email: normalizedEmail,
          participantfirstname: firstName,
          participantlastname: lastName,
          participantrole: "participant",
          participantphone: phone && phone.trim() !== "" ? phone.trim() : null,
          participantcity: city && city.trim() !== "" ? city.trim() : null,
          participantstate: state && state.trim() !== "" ? state.trim() : null,
          participantzip: zip && zip.trim() !== "" ? zip.trim() : null
        })
        .returning("*");

      participantId = newParticipant.participantid;
    }

    // 4) Insert user linked to that participant
    const [user] = await knex("users")
      .insert({
        email: normalizedEmail,
        passwordhashed: hash,
        role: "user",
        participantid: participantId
      })
      .returning("*");

    // 5) Log them in
    req.session.isLoggedIn = true;
    req.session.userId = user.userid;
    req.session.username = user.email;
    req.session.role = user.role;
    req.session.participantId = participantId;

    return res.redirect("/dashboard");
  } catch (err) {
    console.error("signup error", err);
    return renderError("Signup error. Please try again.");
  }
});



// GET /checkEmail
app.get("/checkEmail", (req, res) => {
  res.render("checkEmail");
});

// GET /verify-email/:token
app.get("/verify-email/:token", async (req, res) => {
  const { token } = req.params;
  
  try {
    const user = await knex("users").where({ magic_token: token }).first();
    
    if (!user) {
      req.flash("error", "Invalid or expired verification link.");
      return res.redirect("/signup");
    }
    
    if (
      !user.magic_token_expires_at ||
      new Date(user.magic_token_expires_at) < new Date()
    ) {
      req.flash("error", "Verification link has expired. Please sign up again.");
      return res.redirect("/signup");
    }

    await knex("users")
      .where({ userid: user.userid })
      .update({
        isverified: true,
        magic_token: null,
        magic_token_expires_at: null,
      });

    req.session.userId = user.userid;
    req.session.role = user.role;

    req.flash("success", "Your email has been verified and you are now logged in.");
    res.redirect("/dashboard"); // change to your real route
  } catch (err) {
    console.error(err);
    req.flash("error", "Something went wrong verifying your email.");
    res.redirect("/signup");
  }
});


// Admin-only settings: manage user roles
app.get('/admin/settings', requireManager, async (req, res) => {
  try {
    const users = await knex('users')
      .select('userid', 'email', 'role', 'isverified')
      .orderBy('userid', 'asc');

    return res.render('adminSettings', {
      users,
      error_message: '',
      isManager: true,
      Username: req.session.username,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    console.error('Error loading admin settings:', err);
    return res.render('adminSettings', {
      users: [],
      error_message: 'Error loading users.',
      isManager: true,
      Username: req.session.username,
      csrfToken: req.csrfToken()
    });
  }
});

app.post('/admin/users/:userid/role', requireManager, async (req, res) => {
  const { userid } = req.params;
  const { role } = req.body;

  const allowedRoles = ['manager', 'user', 'secretary'];
  if (!allowedRoles.includes(role)) {
    const users = await knex('users')
      .select('userid', 'email', 'role', 'isverified')
      .orderBy('userid', 'asc');
    return res.render('adminSettings', {
      users,
      error_message: 'Invalid role.',
      isManager: true,
      Username: req.session.username,
      csrfToken: req.csrfToken()
    });
  }

  try {
    await knex('users')
      .where({ userid })
      .update({ role });
    return res.redirect('/admin/settings');
  } catch (err) {
    console.error('Error updating user role:', err);
    const users = await knex('users')
      .select('userid', 'email', 'role', 'isverified')
      .orderBy('userid', 'asc');
    return res.render('adminSettings', {
      users,
      error_message: 'Error updating user role.',
      isManager: true,
      Username: req.session.username,
      csrfToken: req.csrfToken()
    });
  }
});

// Admin: delete user
app.post('/admin/users/:userid/delete', requireManager, async (req, res) => {
  const { userid } = req.params;

  try {
    await knex('users')
      .where({ userid })
      .del();

    return res.redirect('/admin/settings');
  } catch (err) {
    console.error('Error deleting user:', err);
    const users = await knex('users')
      .select('userid', 'email', 'role', 'isverified')
      .orderBy('userid', 'asc');
    return res.render('adminSettings', {
      users,
      error_message: 'Error deleting user.',
      isManager: true,
      Username: req.session.username,
      csrfToken: req.csrfToken()
    });
  }
});

//First, all user go to the landing page
app.get('/', (req, res) => {
  res.render('landing', { 
    
  });
});



app.get('/login', (req, res) => {
   
    res.render('login', { error_message: res.locals.error_message || null });
});


app.post("/login", async (req, res) => {
  const email = req.body.email;
  const password = req.body.password;

  try {
    const hasParticipantColumn = await ensureUsersHasParticipantIdColumn();
    const columns = ["userid", "email", "passwordhashed", "role"];
    if (hasParticipantColumn) {
      columns.push("participantid");
    }

    const user = await knex("users")
      .select(columns)
      .where("email", email.trim().toLowerCase())
      .first();

    console.log(email.trim().toLowerCase())

    if (!user) {
      return res.render("login", { error_message: "Invalid login." });
    }

    const match = await bcrypt.compare(password, user.passwordhashed);

    if (!match) {
      return res.render("login", { error_message: "Invalid login." });
    }

    req.session.isLoggedIn = true;
    req.session.username = user.email;
    req.session.role = user.role;
    req.session.userId = user.userid;
    await syncParticipantSession(req, user);

    return res.redirect("/dashboard");
  } catch (err) {
    console.error("login error", err);
    return res.render("login", {
      error_message: "Login error. Please try again.",
    });
  }
});


app.post("/dev-login-bypass", async (req, res) => {
  const { role } = req.body;

  // Only allow known roles
  const allowedRoles = ["user", "manager", "secretary"];
  if (!allowedRoles.includes(role)) {
    return res.status(400).send("Invalid role");
  }


  try {
    // Find a user with this role; you can adjust this query to match your schema
    const hasParticipantColumn = await ensureUsersHasParticipantIdColumn();
    const columns = ["userid", "email", "role"];
    if (hasParticipantColumn) {
      columns.push("participantid");
    }

    const user = await knex("users")
      .select(columns)
      .where({ role })
      .first();

    if (!user) {
      return res.render("login", {
        error_message: `No user with role '${role}' exists for bypass.`,
      });
    }

    // Set session as if logged in
    req.session.isLoggedIn = true;
    req.session.username = user.username || user.email; // depending on your schema
    req.session.role = user.role;
    req.session.userId = user.userid;
    await syncParticipantSession(req, user);
    return res.redirect("/dashboard");
  } catch (err) {
    console.error("dev-login-bypass error", err);
    return res.render("login", {
      error_message: "Bypass login error. Please try again.",
    });
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
        isManager: req.session.role === 'manager',
        Username: req.session.username
    });
});


app.get('/participants', async (req, res) => {
  if (!req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }

  const isManager = req.session.role === 'manager';
  const participantId = await ensureParticipantId(req);

  // Participant role without a linked participantId returns early.
  if (!isManager && (!participantId || Number.isNaN(participantId))) {
    return res.render('participants', {
      participants: [],
      error_message: 'No participant record is linked to this user.',
      isManager,
      Username: req.session.username,
      selfParticipantId: participantId,
      currentPage: 1,
      totalPages: 1,
      milestoneTitle: '',
      name: '',
      email: '',
      phone: '',
    });
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

    // Participant role scopes to their own participantid.
    if (!isManager && participantId && !Number.isNaN(participantId)) {
      baseQuery.where('p.participantid', participantId);
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
        if (!isManager && participantId && !Number.isNaN(participantId)) {
          q.where('p.participantid', participantId);
        }
      })
      .countDistinct('p.participantid as total');

    const [participants, totalResult] = await Promise.all([
      baseQuery.limit(pageSize).offset(offset),
      countQuery,
    ]);

    // 念のため二重チェックで自分以外を除外
    const scopedParticipants = (!isManager && participantId && !Number.isNaN(participantId))
      ? participants.filter((p) => Number(p.participantid) === participantId)
      : participants;

    const total = (!isManager && participantId && !Number.isNaN(participantId))
      ? scopedParticipants.length
      : (parseInt(totalResult[0].total, 10) || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    console.log('Participants length:', participants.length);
    console.log('Filter milestoneTitle:', milestoneTitle);

    res.render('participants', {
      participants: scopedParticipants,
      error_message: '',
      isManager,
      Username: req.session.username,
      selfParticipantId: participantId,
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
      isManager,
      Username: req.session.username,
      selfParticipantId: participantId,
      currentPage: 1,
      totalPages: 1,
      milestoneTitle: milestoneTitle || '',
      name: name || '',
      email: email || '',
      phone: phone || '',
    });
  }
});

// Add new participant form (manager only)
app.get('/participants/add', (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'manager') {
    return res.render('login', { error_message: 'You do not have permission to add participants.' });
  }

  res.render('participantAdd', {
    error_message: '',
    isManager: true,
    Username: req.session.username,
    csrfToken: req.csrfToken()
  });
});

// Create a new participant (manager only)
app.post('/participants/add', async (req, res) => {

  // Check login status
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }

  // Check manager role
  if (req.session.role !== 'manager') {
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
    return res.render('participantAdd', {
      error_message: 'Error creating participant.',
      isManager: true,
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

  const isManager = req.session.role === 'manager';
  const sessionParticipantId = req.session.participantId;
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
      isManager,
      Username: req.session.username,
      error_message: 'Invalid participant id.'
    });
  }

  // Participant-level users can only view their own record.
  if (!isManager && String(participantid) !== String(sessionParticipantId || '')) {
    return res.status(403).render('participants', {
      participants: [],
      error_message: 'You can only view your own participant record.',
      isManager,
      Username: req.session.username,
      currentPage: 1,
      totalPages: 1,
      milestoneTitle: '',
      name: '',
      email: '',
      phone: '',
    });
  }

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
        isManager,
        Username: req.session.username,
        error_message: 'Participant not found.'
      });
    }

    // 2) Events + registrations
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

    // 4) Surveys (post-event) list
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

    // 6) Registrations first/last timestamps
    const regAgg = await knex('registrations')
      .where({ participantid })
      .min({ firstRegistration: 'registrationcreatedat' })
      .max({ lastRegistration: 'registrationcreatedat' })
      .first();

    const firstRegistration = regAgg ? regAgg.firstRegistration : null;
    const lastRegistration = regAgg ? regAgg.lastRegistration : null;

    // 7) Donations list
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
      isManager,
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
      isManager,
      Username: req.session.username,
      error_message: 'Error loading participant details.'
    });
  }
});

// Edit page: form + editable summary (manager only)
app.get('/participants/:participantid/edit', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }

  const isManager = req.session.role === 'manager';
  const sessionParticipantId = req.session.participantId;
  const participantid = req.params.participantid;

  // Allow managers or the participant themself; block others.
  if (!isManager && String(participantid) !== String(sessionParticipantId || '')) {
    return res.render('login', { error_message: 'You do not have permission to edit this participant.' });
  }

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
      return res.render('participantEdit', {
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
        isManager: req.session.role === 'manager',
        Username: req.session.username,
        error_message: 'Participant not found.'
      });
    }

    const successMessage = req.query.updated ? 'Changes saved.' : '';

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

    return res.render('participantEdit', {
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
      isManager: req.session.role === 'manager',
      Username: req.session.username,
      error_message: '',
      success_message: successMessage
    });
  } catch (err) {
    console.error('Error loading participant (edit route):', err);
    return res.render('participantEdit', {
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
      isManager: req.session.role === 'manager',
      Username: req.session.username,
      success_message: '',
      error_message: 'Error loading participant for editing.'
    });
  }
});



// Update basic participant information (self or manager)
app.post('/participants/:participantid/edit', async (req, res) => {
  const participantid = parseInt(req.params.participantid, 10);
  const isManager = req.session.role === 'manager';
  const sessionParticipantId = req.session.participantId;

  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (Number.isNaN(participantid)) {
    return res.render('login', { error_message: 'Invalid participant id.' });
  }
  if (!isManager && String(participantid) !== String(sessionParticipantId || '')) {
    return res.render('login', { error_message: 'You do not have permission to edit this participant.' });
  }

  const updated = {
    email: req.body.email,
    participantfirstname: req.body.participantfirstname,
    participantlastname: req.body.participantlastname,
    participantdob: req.body.participantdob || null,
    participantrole: req.body.participantrole,
    participantphone: req.body.participantphone,
    participantcity: req.body.participantcity,
    participantstate: req.body.participantstate,
    participantzip: req.body.participantzip,
    participantfieldofinterest: req.body.participantfieldofinterest
  };

  try {
    const rows = await knex('participants')
      .where({ participantid })
      .update(updated);

    if (rows === 0) {
      return res.render('participantEdit', {
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
        isManager,
        Username: req.session.username,
        success_message: '',
        error_message: 'Participant not found.'
      });
    }

    return res.redirect(`/participants/${participantid}/edit?updated=1`);
  } catch (err) {
    console.error("Error updating participant:", err);
    return res.render('participantEdit', {
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
      isManager,
      Username: req.session.username,
      success_message: '',
      error_message: 'Update error.'
    });
  }
});


// Update a single survey row (post-event survey scores) for this participant
app.post('/participants/:participantid/surveys/:surveyid', async (req, res) => {
  const { participantid, surveyid } = req.params;
  if (!req.session || !req.session.isLoggedIn || req.session.role !== 'manager') {
    return res.render('login', { error_message: 'You do not have permission to edit this survey.' });
  }

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
  if (!req.session || !req.session.isLoggedIn || req.session.role !== 'manager') {
    return res.render('login', { error_message: 'You do not have permission to edit this milestone.' });
  }

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
  if (!req.session || !req.session.isLoggedIn || req.session.role !== 'manager') {
    return res.render('login', { error_message: 'You do not have permission to edit this donation.' });
  }

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

  const isManager = req.session.role === 'manager';
  const participantId = await ensureParticipantId(req);

  const pageSize = 25;

  // Separate page numbers for upcoming / past
  const upcomingPage = parseInt(req.query.upcomingPage, 10) || 1;
  const pastPage = parseInt(req.query.pastPage, 10) || 1;

  const rawName = req.query.name || '';
  const rawStartDate = req.query.startDate || '';
  const rawEndDate = req.query.endDate || '';

  // Only managers can use search filters.
  const name = isManager ? rawName : '';
  const startDate = isManager ? rawStartDate : '';
  const endDate = isManager ? rawEndDate : '';
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
    if (!isManager && participantId && !Number.isNaN(participantId)) {
      q.whereExists(
        knex.select(1)
          .from('registrations as rr')
          .whereRaw('rr.eventdetailsid = ed.eventdetailsid')
          .andWhere('rr.participantid', participantId)
      );
    }
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
    if (!isManager && participantId && !Number.isNaN(participantId)) {
      q.whereExists(
        knex.select(1)
          .from('registrations as rr')
          .whereRaw('rr.eventdetailsid = ed.eventdetailsid')
          .andWhere('rr.participantid', participantId)
      );
    }
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
        if (!isManager && participantId && !Number.isNaN(participantId)) {
          q.whereExists(
            knex.select(1)
              .from('registrations as rr')
              .whereRaw('rr.eventdetailsid = ed.eventdetailsid')
              .andWhere('rr.participantid', participantId)
          );
        }
        applyEventFilters(q);
        q.where('ed.eventdatetimestart', '>=', now);
        return q.countDistinct('ed.eventdetailsid as total');
      })(),
      buildPastQuery().limit(pageSize).offset(pastOffset),
      // count distinct eventdetailsid for past
      (function () {
        const q = knex('eventdetails as ed')
          .join('events as e', 'ed.eventid', 'e.eventid');
        if (!isManager && participantId && !Number.isNaN(participantId)) {
          q.whereExists(
            knex.select(1)
              .from('registrations as rr')
              .whereRaw('rr.eventdetailsid = ed.eventdetailsid')
              .andWhere('rr.participantid', participantId)
          );
        }
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
      isManager: req.session.role === 'manager',
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
      isManager: req.session.role === 'manager',
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
  if (req.session.role !== 'manager') {
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

    res.render('eventEdit', {
      event,
      error_message: '',
      isManager: req.session.role === 'manager',
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
  if (req.session.role !== 'manager') {
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
  if (req.session.role !== 'manager') {
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

  const isManager = req.session.role === 'manager';
  const participantId = await ensureParticipantId(req);

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
    // Participant view: show answered vs pending surveys for this participant only.
    if (!isManager) {
      if (!participantId || Number.isNaN(participantId)) {
        return res.render('survey', {
          surveys: [],
          answeredSurveys: [],
          pendingSurveys: [],
          error_message: 'No participant record is linked to this user.',
          isManager,
          Username: req.session.username,
          eventName,
          participantName,
          startDate,
          endDate,
          currentPage: 1,
          totalPages: 1,
          surveyFormUrl: 'https://docs.google.com/forms/d/e/1FAIpQLSdaqLFLzHmIaGtDwW7rkV8Wk2iok9PMk8t6ZXcylShk34YNGQ/viewform'
        });
      }

      // Answered surveys: participant + has satisfaction score
      const answeredSurveys = await knex('surveys as s')
        .join('events as e', 's.eventid', 'e.eventid')
        .join('eventdetails as ed', function () {
          this.on('ed.eventid', '=', 's.eventid')
              .andOn('ed.eventdatetimestart', '=', 's.eventdatetimestart');
        })
        .leftJoin('registrations as r', function () {
          this.on('r.participantid', '=', 's.participantid')
              .andOn('r.eventdetailsid', '=', 'ed.eventdetailsid');
        })
        .where('s.participantid', participantId)
        .whereNotNull('s.surveysatisfactionscore')
        .select(
          's.surveyid',
          'e.eventname',
          's.eventdatetimestart',
          'ed.eventlocation',
          's.surveysatisfactionscore',
          's.surveyusefulnessscore',
          's.surveyinstructorscore',
          's.surveyrecommendationscore',
          's.surveyoverallscore',
          's.surveysubmissiondate',
          'r.registrationattendanceflag'
        )
        .orderBy('s.surveysubmissiondate', 'desc');

      // Pending surveys: attended events with no submitted survey
      const pendingSurveys = await knex('registrations as r')
        .join('eventdetails as ed', 'r.eventdetailsid', 'ed.eventdetailsid')
        .join('events as e', 'ed.eventid', 'e.eventid')
        .leftJoin('surveys as s', function () {
          this.on('s.participantid', '=', 'r.participantid')
              .andOn('s.eventid', '=', 'e.eventid')
              .andOn('s.eventdatetimestart', '=', 'ed.eventdatetimestart');
        })
        .where('r.participantid', participantId)
        .andWhere('r.registrationattendanceflag', true)
        .andWhere(function () {
          this.whereNull('s.surveyid')
              .orWhereNull('s.surveysatisfactionscore');
        })
        .select(
          'e.eventid',
          'e.eventname',
          'ed.eventdatetimestart',
          'ed.eventlocation',
          'r.registrationattendanceflag'
        )
        .orderBy('ed.eventdatetimestart', 'desc');

      return res.render('survey', {
        surveys: [],
        answeredSurveys,
        pendingSurveys,
        error_message: '',
        isManager,
        Username: req.session.username,
        eventName,
        participantName,
        startDate,
        endDate,
        currentPage: 1,
        totalPages: 1,
        surveyFormUrl: 'https://docs.google.com/forms/d/e/1FAIpQLSdaqLFLzHmIaGtDwW7rkV8Wk2iok9PMk8t6ZXcylShk34YNGQ/viewform'
      });
    }

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
      .leftJoin('registrations as r', function () {
        this.on('r.participantid', '=', 's.participantid')
            .andOn('r.eventdetailsid', '=', 'ed.eventdetailsid');
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
        's.surveysubmissiondate',
        'r.registrationattendanceflag'
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
      isManager,
      Username: req.session.username,
      eventName,
      participantName,
      startDate,
      endDate,
      currentPage: page,
      totalPages,
      surveyFormUrl: 'https://docs.google.com/forms/d/e/1FAIpQLSdaqLFLzHmIaGtDwW7rkV8Wk2iok9PMk8t6ZXcylShk34YNGQ/viewform'
    });

  } catch (err) {
    console.error('Error loading surveys:', err);
    return res.render('survey', {
      surveys: [],
      answeredSurveys: [],
      pendingSurveys: [],
      error_message: 'Error loading surveys.',
      isManager,
      Username: req.session.username,
      eventName,
      participantName,
      startDate,
      endDate,
      currentPage: 1,
      totalPages: 1,
      surveyFormUrl: 'https://docs.google.com/forms/d/e/1FAIpQLSdaqLFLzHmIaGtDwW7rkV8Wk2iok9PMk8t6ZXcylShk34YNGQ/viewform'
    });
  }
});


// =======================================
// Survey - show "new survey" form (manager)
// =======================================
app.get('/surveys/new', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'manager') {
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

    return res.render('surveyNew', {
      events,
      participants,
      error_message: '',
      isManager: true,
      Username: req.session.username,
      // csrfToken is already in res.locals
    });
  } catch (err) {
    console.error('Error loading data for new survey:', err);
    return res.render('surveyNew', {
      events: [],
      participants: [],
      error_message: 'Error loading data for new survey.',
      isManager: true,
      Username: req.session.username
    });
  }
});

// =====================================
// Survey - create new survey (manager)
// =====================================
app.post('/surveys/new', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'manager') {
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
    return res.render('surveyNew', {
      events: [],
      participants: [],
      error_message: 'Error inserting new survey.',
      isManager: true,
      Username: req.session.username
    });
  }
});


// =====================================
// Survey - show edit form (manager only)
// =====================================
app.get('/surveys/:surveyid/edit', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'manager') {
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

    return res.render('surveyEdit', {
      survey,
      error_message: '',
      isManager: req.session.role === 'manager',
      Username: req.session.username,
      csrfToken: req.csrfToken()  
    });
  } catch (err) {
    console.error('Error loading survey for edit:', err);
    return res.send('Error loading survey for edit.');
  }
});


// =====================================
// Survey - update existing survey (manager)
// =====================================
app.post('/surveys/:surveyid/edit', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'manager') {
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
// Survey - delete (manager only)
// =====================================
app.post('/surveys/:surveyid/delete', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'manager') {
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

  const isManager = req.session.role === 'manager';
  const sessionParticipantId = await ensureParticipantId(req);

  if (!isManager && (!sessionParticipantId || Number.isNaN(sessionParticipantId))) {
    return res.render('milestones', {
      milestones: [],
      error_message: 'No participant record is linked to this user.',
      isManager,
      selfParticipantId: sessionParticipantId,
      Username: req.session.username,
      participantName: '',
      email: '',
      milestoneTitle: '',
      startDate: '',
      endDate: '',
      currentPage: 1,
      totalPages: 1,
      csrfToken: req.csrfToken()
    });
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

    if (!isManager && sessionParticipantId && !Number.isNaN(sessionParticipantId)) {
      baseQuery.where('p.participantid', sessionParticipantId);
    }

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
        if (!isManager && sessionParticipantId && !Number.isNaN(sessionParticipantId)) {
          q.where('p.participantid', sessionParticipantId);
        }
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
      isManager,
      selfParticipantId: sessionParticipantId,
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
      isManager,
      selfParticipantId: sessionParticipantId,
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
// Milestones - new (manager only, GET)
// =====================================
app.get('/milestones/new', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  const isManager = req.session.role === 'manager';
  const sessionParticipantId = await ensureParticipantId(req);

  if (!isManager && (!sessionParticipantId || Number.isNaN(sessionParticipantId))) {
    return res.render('login', {
      error_message: 'You do not have permission to add milestones.'
    });
  }

  const prefillEmail = req.query.email || '';

  return res.render('milestonesNew', {
    email: prefillEmail,
    milestonetitle: '',
    milestonedate: '',
    error_message: '',
    isManager,
    Username: req.session.username,
    selfParticipantId: sessionParticipantId,
    csrfToken: req.csrfToken()
  });
});



// =====================================
// Milestones - create (manager only, POST)
// =====================================
app.post('/milestones/new', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  const isManager = req.session.role === 'manager';
  const sessionParticipantId = req.session.participantId
    ? parseInt(req.session.participantId, 10)
    : null;
  if (!isManager && (!sessionParticipantId || Number.isNaN(sessionParticipantId))) {
    return res.render('login', {
      error_message: 'You do not have permission to add milestones.'
    });
  }

  const { email, milestonetitle, milestonedate } = req.body;

  try {
    let participantIdToUse = null;

    if (isManager) {
      const participant = await knex('participants')
        .whereILike('email', email.trim())
        .first();

      if (!participant) {
        return res.render('milestonesNew', {
          email,
          milestonetitle,
          milestonedate,
          error_message: 'No participant found with that email.',
          isManager,
          Username: req.session.username,
          selfParticipantId: sessionParticipantId,
          csrfToken: req.csrfToken()
        });
      }
      participantIdToUse = participant.participantid;
    } else {
      participantIdToUse = sessionParticipantId;
    }

    await knex('milestones').insert({
      participantid: participantIdToUse,
      milestonetitle: milestonetitle || null,
      milestonedate: milestonedate || null
    });

    return res.redirect('/milestones');
  } catch (err) {
    console.error('Error creating milestone:', err);
    return res.render('milestonesNew', {
      email,
      milestonetitle,
      milestonedate,
      error_message: 'Error creating milestone.',
      isManager,
      Username: req.session.username,
      selfParticipantId: sessionParticipantId,
      csrfToken: req.csrfToken()
    });
  }
});



app.get('/milestones/:milestoneid/edit', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  const isManager = req.session.role === 'manager';
  const sessionParticipantId = req.session.participantId
    ? parseInt(req.session.participantId, 10)
    : null;

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

    if (!milestone) {
      return res.render('milestonesEdit', {
        milestone: null,
        participants: [],
        error_message: 'Milestone not found.',
        isManager,
        Username: req.session.username,
        csrfToken: req.csrfToken()
      });
    }

    if (!isManager && String(milestone.participantid) !== String(sessionParticipantId || '')) {
      return res.render('login', {
        error_message: 'You do not have permission to edit milestones.'
      });
    }

    let participants = [];
    if (isManager) {
      participants = await knex('participants')
        .select(
          'participantid',
          'participantfirstname',
          'participantlastname',
          'email'
        )
        .orderBy('participantlastname', 'asc')
        .orderBy('participantfirstname', 'asc');
    }

    return res.render('milestonesEdit', {
      milestone,
      participants,                      
      error_message: '',
      isManager,
      Username: req.session.username,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    console.error('Error loading milestone for edit:', err);
    return res.render('milestonesEdit', {
      milestone: null,
      participants: [],              
      error_message: 'Error loading milestone for edit.',
      isManager,
      Username: req.session.username,
      csrfToken: req.csrfToken()
    });
  }
});


// =====================================
// Milestones - update (manager only, POST)
// =====================================
app.post('/milestones/:milestoneid/edit', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  const isManager = req.session.role === 'manager';
  const sessionParticipantId = req.session.participantId
    ? parseInt(req.session.participantId, 10)
    : null;

  const { milestoneid } = req.params;
  const { milestonetitle, milestonedate } = req.body;

  try {
    // Ensure ownership for participant users
    if (!isManager) {
      const row = await knex('milestones')
        .where({ milestoneid })
        .first('participantid');
      if (!row || String(row.participantid) !== String(sessionParticipantId || '')) {
        return res.render('login', {
          error_message: 'You do not have permission to edit milestones.'
        });
      }
    }

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
// Milestones - delete (manager only, POST)
// =====================================
app.post('/milestones/:milestoneid/delete', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'manager') {
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



// ===============================
// Donations - list (manager or self)
// ===============================
app.get('/donations', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }

  const isManager = req.session.role === 'manager';
  const sessionParticipantId = await ensureParticipantId(req);

  const pageSize = 25;
  const page = parseInt(req.query.page, 10) || 1;
  const offset = (page - 1) * pageSize;

  const name = req.query.name ? req.query.name.trim() : '';
  const email = req.query.email ? req.query.email.trim() : '';
  const startDate = req.query.startDate ? req.query.startDate.trim() : '';
  const endDate = req.query.endDate ? req.query.endDate.trim() : '';

  if (!isManager && (!sessionParticipantId || Number.isNaN(sessionParticipantId))) {
    return res.render('donations', {
      donations: [],
      totalAmount: 0,
      error_message: 'No participant record is linked to this user.',
      isManager,
      Username: req.session.username,
      selfParticipantId: sessionParticipantId,
      name,
      email,
      startDate,
      endDate,
      currentPage: 1,
      totalPages: 1,
      csrfToken: req.csrfToken()
    });
  }

  try {
    const baseQuery = knex('donations as d')
      .join('participants as p', 'd.participantid', 'p.participantid')
      .select(
        'd.donationid',
        'd.donationdate',
        'd.donationamount',
        'p.participantid',
        'p.participantfirstname',
        'p.participantlastname',
        'p.email'
      );

    if (!isManager && sessionParticipantId && !Number.isNaN(sessionParticipantId)) {
      baseQuery.where('p.participantid', sessionParticipantId);
    }

    if (name !== '') {
      const lower = name.toLowerCase();
      baseQuery.whereRaw(
        "LOWER(p.participantfirstname || ' ' || p.participantlastname) LIKE ?",
        [`%${lower}%`]
      );
    }

    if (email !== '') {
      baseQuery.whereILike('p.email', `%${email}%`);
    }

    if (startDate !== '') {
      baseQuery.where('d.donationdate', '>=', startDate);
    }
    if (endDate !== '') {
      baseQuery.where('d.donationdate', '<=', endDate);
    }

    const countQuery = knex('donations as d')
      .join('participants as p', 'd.participantid', 'p.participantid')
      .modify((q) => {
        if (!isManager && sessionParticipantId && !Number.isNaN(sessionParticipantId)) {
          q.where('p.participantid', sessionParticipantId);
        }
        if (name !== '') {
          const lower = name.toLowerCase();
          q.whereRaw(
            "LOWER(p.participantfirstname || ' ' || p.participantlastname) LIKE ?",
            [`%${lower}%`]
          );
        }
        if (email !== '') {
          q.whereILike('p.email', `%${email}%`);
        }
        if (startDate !== '') {
          q.where('d.donationdate', '>=', startDate);
        }
        if (endDate !== '') {
          q.where('d.donationdate', '<=', endDate);
        }
      })
      .countDistinct('d.donationid as total');

    const sumQuery = knex('donations as d')
      .join('participants as p', 'd.participantid', 'p.participantid')
      .modify((q) => {
        if (!isManager && sessionParticipantId && !Number.isNaN(sessionParticipantId)) {
          q.where('p.participantid', sessionParticipantId);
        }
        if (name !== '') {
          const lower = name.toLowerCase();
          q.whereRaw(
            "LOWER(p.participantfirstname || ' ' || p.participantlastname) LIKE ?",
            [`%${lower}%`]
          );
        }
        if (email !== '') {
          q.whereILike('p.email', `%${email}%`);
        }
        if (startDate !== '') {
          q.where('d.donationdate', '>=', startDate);
        }
        if (endDate !== '') {
          q.where('d.donationdate', '<=', endDate);
        }
      })
      .sum({ total_amount: 'd.donationamount' });

    const [donations, totalResult, sumResult] = await Promise.all([
      baseQuery.orderBy('d.donationdate', 'desc').limit(pageSize).offset(offset),
      countQuery,
      sumQuery
    ]);

    const total = parseInt(totalResult[0].total, 10) || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const totalAmount = sumResult && sumResult[0].total_amount
      ? Number(sumResult[0].total_amount)
      : 0;

    return res.render('donations', {
      donations,
      totalAmount,
      error_message: '',
      isManager,
      Username: req.session.username,
      selfParticipantId: sessionParticipantId,
      name,
      email,
      startDate,
      endDate,
      currentPage: page,
      totalPages,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    console.error('Error loading donations:', err);
    return res.render('donations', {
      donations: [],
      totalAmount: 0,
      error_message: 'Error loading donations.',
      isManager,
      Username: req.session.username,
      selfParticipantId: sessionParticipantId,
      name,
      email,
      startDate,
      endDate,
      currentPage: 1,
      totalPages: 1,
      csrfToken: req.csrfToken()
    });
  }
});

// Donations - new (manager or self)
app.get('/donations/new', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  const isManager = req.session.role === 'manager';
  const sessionParticipantId = req.session.participantId
    ? parseInt(req.session.participantId, 10)
    : null;

  if (!isManager && (!sessionParticipantId || Number.isNaN(sessionParticipantId))) {
    return res.render('login', {
      error_message: 'You do not have permission to add donations.'
    });
  }

  return res.render('donationsNew', {
    error_message: '',
    isManager,
    Username: req.session.username,
    selfParticipantId: sessionParticipantId,
    csrfToken: req.csrfToken(),
    email: '',
    donationamount: '',
    donationdate: ''
  });
});

app.post('/donations/new', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  const isManager = req.session.role === 'manager';
  const sessionParticipantId = req.session.participantId
    ? parseInt(req.session.participantId, 10)
    : null;

  if (!isManager && (!sessionParticipantId || Number.isNaN(sessionParticipantId))) {
    return res.render('login', {
      error_message: 'You do not have permission to add donations.'
    });
  }

  const { email, donationamount, donationdate } = req.body;

  try {
    let participantIdToUse = null;
    if (isManager) {
      const participant = await knex('participants')
        .whereILike('email', (email || '').trim())
        .first();
      if (!participant) {
        return res.render('donationsNew', {
          error_message: 'No participant found with that email.',
          isManager,
          Username: req.session.username,
          selfParticipantId: sessionParticipantId,
          csrfToken: req.csrfToken(),
          email,
          donationamount,
          donationdate
        });
      }
      participantIdToUse = participant.participantid;
    } else {
      participantIdToUse = sessionParticipantId;
    }

    await knex('donations').insert({
      participantid: participantIdToUse,
      donationamount: donationamount || null,
      donationdate: donationdate || null
    });

    return res.redirect('/donations');
  } catch (err) {
    console.error('Error creating donation:', err);
    return res.render('donationsNew', {
      error_message: 'Error creating donation.',
      isManager,
      Username: req.session.username,
      selfParticipantId: sessionParticipantId,
      csrfToken: req.csrfToken(),
      email,
      donationamount,
      donationdate
    });
  }
});

// Donations - edit (manager only)
app.get('/donations/:donationid/edit', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  const isManager = req.session.role === 'manager';
  if (!isManager) {
    return res.render('login', { error_message: 'You do not have permission to edit donations.' });
  }
  const sessionParticipantId = await ensureParticipantId(req);

  const { donationid } = req.params;

  try {
    const donation = await knex('donations as d')
      .join('participants as p', 'd.participantid', 'p.participantid')
      .where('d.donationid', donationid)
      .select(
        'd.donationid',
        'd.donationdate',
        'd.donationamount',
        'p.participantid',
        'p.participantfirstname',
        'p.participantlastname',
        'p.email'
      )
      .first();

    if (!donation) {
      return res.render('donationsEdit', {
        donation: null,
        error_message: 'Donation not found.',
        isManager,
        Username: req.session.username,
        selfParticipantId: sessionParticipantId,
        csrfToken: req.csrfToken()
      });
    }

    return res.render('donationsEdit', {
      donation,
      error_message: '',
      isManager,
      Username: req.session.username,
      selfParticipantId: sessionParticipantId,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    console.error('Error loading donation for edit:', err);
    return res.render('donationsEdit', {
      donation: null,
      error_message: 'Error loading donation.',
      isManager,
      Username: req.session.username,
      selfParticipantId: sessionParticipantId,
      csrfToken: req.csrfToken()
    });
  }
});

app.post('/donations/:donationid/edit', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  const isManager = req.session.role === 'manager';
  if (!isManager) {
    return res.render('login', { error_message: 'You do not have permission to edit donations.' });
  }
  const sessionParticipantId = await ensureParticipantId(req);

  const { donationid } = req.params;
  const { donationamount, donationdate, email } = req.body;

  try {
    const donationRow = await knex('donations').where({ donationid }).first('participantid');
    if (!donationRow) {
      return res.render('donationsEdit', {
        donation: null,
        error_message: 'Donation not found.',
        isManager,
        Username: req.session.username,
        selfParticipantId: sessionParticipantId,
        csrfToken: req.csrfToken()
      });
    }

    let participantIdToUse = donationRow.participantid;
    if (isManager && email) {
      const participant = await knex('participants')
        .whereILike('email', email.trim())
        .first();
      if (!participant) {
        const donation = await knex('donations as d')
          .join('participants as p', 'd.participantid', 'p.participantid')
          .where('d.donationid', donationid)
          .select(
            'd.donationid',
            'd.donationdate',
            'd.donationamount',
            'p.participantid',
            'p.participantfirstname',
            'p.participantlastname',
            'p.email'
          )
          .first();
        return res.render('donationsEdit', {
          donation,
          error_message: 'No participant found with that email.',
          isManager,
          Username: req.session.username,
          selfParticipantId: sessionParticipantId,
          csrfToken: req.csrfToken()
        });
      }
      participantIdToUse = participant.participantid;
    }

    await knex('donations')
      .where({ donationid })
      .update({
        participantid: participantIdToUse,
        donationamount: donationamount || null,
        donationdate: donationdate || null
      });

    return res.redirect('/donations');
  } catch (err) {
    console.error('Error updating donation:', err);
    const donation = await knex('donations as d')
      .join('participants as p', 'd.participantid', 'p.participantid')
      .where('d.donationid', donationid)
      .select(
        'd.donationid',
        'd.donationdate',
        'd.donationamount',
        'p.participantid',
        'p.participantfirstname',
        'p.participantlastname',
        'p.email'
      )
      .first();

    return res.render('donationsEdit', {
      donation,
      error_message: 'Error updating donation.',
      isManager,
      Username: req.session.username,
      selfParticipantId: sessionParticipantId,
      csrfToken: req.csrfToken()
    });
  }
});

// Donations - delete (manager only)
app.post('/donations/:donationid/delete', async (req, res) => {
  if (!req.session || !req.session.isLoggedIn) {
    return res.render('login', { error_message: null });
  }
  if (req.session.role !== 'manager') {
    return res.render('login', {
      error_message: 'You do not have permission to delete donations.'
    });
  }

  const { donationid } = req.params;

  try {
    await knex('donations')
      .where({ donationid })
      .del();

    return res.redirect('/donations');
  } catch (err) {
    console.error('Error deleting donation:', err);
    return res.send('Error deleting donation.');
  }
});



app.listen(port, () => {
    console.log("The server is listening");
    console.log(`Server running on http://localhost:${port}`);
})
