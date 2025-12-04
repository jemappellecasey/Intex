// reset-all-passwords.js
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
const bcrypt = require('bcrypt');

const DEFAULT_PASSWORD = 'devpass'; // choose your dev default
const sr = process.env.SALT_ROUNDS;

(async () => {
  try {
    const hash = await bcrypt.hash(DEFAULT_PASSWORD, sr);

    await knex('users').update({ passwordhashed: hash }); // updates every row

    console.log('All user passwords reset to default (hashed).');
    process.exit(0);
  } catch (err) {
    console.error('Error updating passwords:', err);
    process.exit(1);
  }
})();
