export const SECTIONS = [
  { key: "marketing.statistics", label: "Статистика" },
  { key: "marketing.data_entry", label: "Внесение данных" },
  { key: "marketing.publications", label: "Публикации" },
  { key: "marketing.instagram_target", label: "Инстаграм таргет" },
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
