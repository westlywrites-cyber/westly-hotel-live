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
--   website with no auth). Admin panel writes (insert/update/delete) go
--   through server-side Cloudflare Functions (see
--   functions/api/media-upload.ts, functions/api/media-delete.ts) using a
--   service-role key gated by a real Firebase-authenticated staff
--   session — not the public anon key (see the Phase 2 security audit,
--   finding C-3; the anon key previously had insert/update/delete on this
--   bucket, so anyone holding it could write or delete files directly).
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

-- Anon insert/update/delete policies intentionally removed — see the file
-- header above. Service-role calls (used by the Functions listed there)
-- bypass RLS by design, so no anon/authenticated replacement policy is
-- needed for these operations.
drop policy if exists "westly-media anon upload" on storage.objects;
drop policy if exists "westly-media anon update" on storage.objects;
drop policy if exists "westly-media anon delete" on storage.objects;
