-- The bell already stops counting a notification once it's been opened
-- (user_notification_reads.last_read_at), but it still stayed in the list
-- forever. Now each row gets its own "ОК" button that deletes it outright —
-- viewing ≠ dismissing. Deletion is shared (not per-user): these are
-- system-wide alerts (sync failures), so one admin acknowledging it clears
-- it for everyone, same as how the notification itself is shared.
create policy notifications_delete_authenticated on public.notifications
  for delete using (auth.role() = 'authenticated');
