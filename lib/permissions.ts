// Grouped the same way the sidebar nav already groups its pages (see
// WAREHOUSE_SUBMENU/MARKETING_SUBMENU/SETTINGS_SUBMENU in Sidebar.tsx) so
// the permissions list in Настройки/Сотрудники reads the same way. Requests,
// accounts and self-rename don't live under any of those three sidebar
// groups, so they land in a fourth "Общие" bucket here.
export const PERMISSION_GROUPS = [
  { key: "warehouse", label: "Склад" },
  { key: "marketing", label: "Маркетинг" },
  { key: "settings", label: "Настройки" },
  { key: "general", label: "Общие" },
] as const;
export type PermissionGroupKey = (typeof PERMISSION_GROUPS)[number]["key"];

// hasEdit: false means the section's page has nothing an "edit" checkbox
// could ever unlock — it's a pure view (a report/log with no create/update/
// delete action anywhere), confirmed by grepping every page gated by that
// section for a `.canEdit` (or equivalent) usage. Keep this in sync if a
// page later grows an edit action.
//
// viewless: true is the mirror case — there's nothing to "view" here, only
// an action to allow or not (app/api/profile/route.ts checks can_edit only,
// never can_view). The grid shows a single checkbox for these and keeps
// canView/canEdit equal under the hood, so the stored data never drifts
// into the confusing "view unchecked, edit checked" state the UI used to
// allow.
export const SECTIONS = [
  { key: "warehouse.stock", label: "Склад (АВС/XYZ, Зависшие остатки)", group: "warehouse", hasEdit: false },

  { key: "marketing.statistics", label: "Статистика (+ Обзор, Продажа)", group: "marketing", hasEdit: false },
  { key: "marketing.data_entry", label: "Внесение данных", group: "marketing", hasEdit: true },
  { key: "marketing.publications", label: "Публикации", group: "marketing", hasEdit: true },
  { key: "marketing.instagram_target", label: "Инстаграм таргет", group: "marketing", hasEdit: false },
  { key: "marketing.competitor_analytics", label: "Аналитика конкурентов", group: "marketing", hasEdit: true },

  { key: "settings.employees", label: "Сотрудники и доступы", group: "settings", hasEdit: true },
  { key: "settings.passwords", label: "Пароли", group: "settings", hasEdit: true },
  { key: "history", label: "История", group: "settings", hasEdit: false },

  { key: "requests", label: "Запросы", group: "general", hasEdit: true },
  { key: "profile.rename", label: "Смена имени сотрудника", group: "general", hasEdit: true, viewless: true },
] as const;

export type SectionKey = (typeof SECTIONS)[number]["key"];

export type SectionAccess = { canView: boolean; canEdit: boolean };
export type Permissions = Record<SectionKey, SectionAccess>;

export function emptyPermissions(): Permissions {
  return SECTIONS.reduce((acc, s) => {
    acc[s.key] = { canView: false, canEdit: false };
    return acc;
  }, {} as Permissions);
}

export function fullPermissions(): Permissions {
  return SECTIONS.reduce((acc, s) => {
    acc[s.key] = { canView: true, canEdit: true };
    return acc;
  }, {} as Permissions);
}
