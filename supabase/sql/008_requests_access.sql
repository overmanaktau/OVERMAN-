-- Lets a role be granted delegated view/edit access to the "Запросы" section
-- itself (who can see every request, not just their own, and approve/deny
-- them), instead of that being hardcoded to true admins only.
-- Run once in the Supabase SQL Editor. Safe to re-run.

drop policy if exists edit_requests_select on public.edit_requests;

create policy edit_requests_select on public.edit_requests
  for select using (requested_by = auth.uid() or public.has_access('requests', 'view'));
