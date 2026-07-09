const { execSync } = require('child_process');
const fs = require('fs');

console.log("Starting automated D1 Database setup...");

try {
  const DB_NAME = "link-short-db";
  let dbUuid = "";

  // 1. Get database list to check if it already exists
  console.log("Checking existing D1 databases...");
  try {
    const listOutput = execSync('npx wrangler d1 list --json', { encoding: 'utf-8' });
    // Clean potential wrangler output header logs
    const jsonStart = listOutput.indexOf('[');
    if (jsonStart !== -1) {
      const cleanJson = listOutput.substring(jsonStart);
      const databases = JSON.parse(cleanJson);
      const db = databases.find(d => d.name === DB_NAME);
      if (db) {
        dbUuid = db.uuid;
        console.log(`Found existing D1 database '${DB_NAME}' with ID: ${dbUuid}`);
      }
    }
  } catch (e) {
    console.log("Could not fetch database list, attempting to create direct...");
  }

  // 2. If it doesn't exist, create it
  if (!dbUuid) {
    console.log(`Database '${DB_NAME}' not found. Creating a new one...`);
    const createOutput = execSync(`npx wrangler d1 create ${DB_NAME}`, { encoding: 'utf-8' });
    
    // Extract UUID format (8-4-4-4-12 hex chars) from wrangler output
    const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const match = createOutput.match(uuidRegex);
    if (match) {
      dbUuid = match[0];
      console.log(`Successfully created database. Extracted ID: ${dbUuid}`);
    } else {
      throw new Error(`Failed to parse database ID from wrangler output: ${createOutput}`);
    }
  }

  if (dbUuid) {
    // 3. Update wrangler.toml with the database_id
    let config = fs.readFileSync('wrangler.toml', 'utf8');
    config = config.replace(/database_id = .*/, `database_id = "${dbUuid}"`);
    config = config.replace(/database_name = .*/, `database_name = "${DB_NAME}"`);
    fs.writeFileSync('wrangler.toml', config);
    console.log(`Successfully updated wrangler.toml with database_name: ${DB_NAME} and database_id: ${dbUuid}`);

    // 4. Apply migrations to the database
    console.log("Applying database migrations...");
    execSync(`npx wrangler d1 migrations apply ${DB_NAME} --remote`, { stdio: 'inherit' });
  } else {
    throw new Error("Could not find or create D1 database ID.");
  }
} catch (err) {
  console.error("D1 Automation failed:", err.message);
  process.exit(1);
}
