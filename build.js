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
    const createOutput = execSync(`npx wrangler d1 create ${DB_NAME} --json`, { encoding: 'utf-8' });
    const jsonStart = createOutput.indexOf('{');
    if (jsonStart !== -1) {
      const cleanJson = createOutput.substring(jsonStart);
      const result = JSON.parse(cleanJson);
      dbUuid = result.database_id || result.uuid;
      console.log(`Created new D1 database with ID: ${dbUuid}`);
    } else {
      // Regex fallback if not clean JSON
      const match = createOutput.match(/database_id\s*=\s*"([^"]+)"/) || createOutput.match(/"database_id":\s*"([^"]+)"/);
      if (match) {
        dbUuid = match[1];
        console.log(`Extracted database ID: ${dbUuid}`);
      }
    }
  }

  if (dbUuid) {
    // 3. Update wrangler.toml with the database_id
    let config = fs.readFileSync('wrangler.toml', 'utf8');
    config = config.replace(/database_id = .*/, `database_id = "${dbUuid}"`);
    fs.writeFileSync('wrangler.toml', config);
    console.log("Successfully updated wrangler.toml with D1 database_id.");

    // 4. Apply migrations to the database
    console.log("Applying database migrations...");
    execSync(`npx wrangler d1 migrations apply ${DB_NAME} --remote --yes`, { stdio: 'inherit' });
  } else {
    throw new Error("Could not find or create D1 database ID.");
  }
} catch (err) {
  console.error("D1 Automation failed:", err.message);
  process.exit(1);
}
