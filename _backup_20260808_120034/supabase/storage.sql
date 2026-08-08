-- ══════════════════════════════════════════════════════════════════════════
-- Westly Hotel — Supabase Storage for image uploads
--
-- This has already been applied to the connected Westly Hotel Supabase
-- project. Kept here (matching supabase/schema.sql's convention) so it's
-- reproducible if you ever need to re-run it against a fresh project.
--
-- What this sets up:
--   One public bucket, "westly-media", used ONLY by the features that used
--   to require a pasted image URL: Hotel rooms, Hotel facilities,
--   Lost & Found, Restaurant menu, CMS Hero section, CMS About section, and
--   the Gallery page. Every other feature in the app (bookings, payments,
--   staff, etc.) continues to run on Firebase and is untouched by this file.
--
--   Files are organized in folders per feature:
--     rooms/, facilities/, lost-found/, restaurant-menu/, cms-hero/,
--     cms-about/, gallery/, venues/, cms-venue-hero/
--
--   The bucket is public for read (so uploaded images render on the public
--   website with no auth). Admin panel writes (insert/update/delete) use the
--   same anon key + app-level Firebase-based RBAC pattern already used for
--   public.messages (see schema.sql) — access to the admin screens that can
--   upload is enforced by this app's own role checks, since staff
--   identity/roles live in Firebase Auth, not Supabase Auth.
-- ══════════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('westly-media', 'westly-media', true, 8388608, array['image/jpeg','image/png','image/webp','image/gif','image/avif'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "westly-media public read" on storage.objects;
create policy "westly-media public read"
  on storage.objects
  for select
  to public
  using (bucket_id = 'westly-media');

drop policy if exists "westly-media anon upload" on storage.objects;
create policy "westly-media anon upload"
  on storage.objects
  for insert
  to anon
  with check (bucket_id = 'westly-media');

drop policy if exists "westly-media anon update" on storage.objects;
create policy "westly-media anon update"
  on storage.objects
  for update
  to anon
  using (bucket_id = 'westly-media')
  with check (bucket_id = 'westly-media');

drop policy if exists "westly-media anon delete" on storage.objects;
create policy "westly-media anon delete"
  on storage.objects
  for delete
  to anon
  using (bucket_id = 'westly-media');
