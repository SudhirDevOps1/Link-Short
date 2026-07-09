-- D1 Migration: Add User Scoping for SaaS multi-user url shortener

ALTER TABLE links ADD COLUMN user_id INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_links_user_id ON links(user_id);
