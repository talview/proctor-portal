-- users.name never existed -- the app's own User type/auth store already carried a
-- `name` field, but it was only ever a cosmetic transform of the username
-- (`username.replace(/_/g, ' ')`), not a real display name an admin could set. This
-- is what the Workspace greeting ("Good morning, {name}") actually shows.
alter table users add column if not exists name text;
