"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/apiClient";
import { supabase } from "@/lib/supabaseClient";
import { SECTIONS, emptyPermissions, type Permissions } from "@/lib/permissions";
import { useAuth } from "@/components/AuthGate";
import { useUnsavedChanges } from "@/components/UnsavedChangesContext";

const ONLINE_THRESHOLD_MS = 2 * 60 * 1000;

type LoginEvent = { logged_in_at: string; user_agent: string | null };

function parseUserAgent(ua: string | null): string {
  if (!ua) return "Неизвестное устройство";

  let os = "Неизвестная ОС";
  if (/Windows/i.test(ua)) os = "Windows";
  else if (/Mac OS X/i.test(ua)) os = "macOS";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/iPhone|iPad|iOS/i.test(ua)) os = "iOS";
  else if (/Linux/i.test(ua)) os = "Linux";

  let browser = "Неизвестный браузер";
  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/OPR\//i.test(ua)) browser = "Opera";
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = "Chrome";
  else if (/Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = "Safari";

  return `${browser}, ${os}`;
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

type Employee = {
  id: string;
  email: string;
  fullName: string | null;
  role: "owner" | "admin" | "editor" | null;
  roleId: number | null;
};

type StoreAccessGrant = { scope: "all" | "city" | "store"; cityId: number | null; storeId: number | null };

type RoleDef = {
  id: number;
  name: string;
  is_personal: boolean;
  role_permissions: { section: string; can_view: boolean; can_edit: boolean }[];
  role_store_access: { scope: "all" | "city" | "store"; city_id: number | null; store_id: number | null }[];
};

type CityWithStores = { id: number; name: string; stores: { id: number; name: string; code: string }[] };

function toPermissions(rows: RoleDef["role_permissions"]): Permissions {
  const p = emptyPermissions();
  for (const row of rows) {
    if (row.section in p) {
      p[row.section as keyof Permissions] = { canView: row.can_view, canEdit: row.can_edit };
    }
  }
  return p;
}

function toGrants(rows: RoleDef["role_store_access"]): StoreAccessGrant[] {
  return rows.map((r) => ({ scope: r.scope, cityId: r.city_id, storeId: r.store_id }));
}

function resolveStoreLabel(emp: Employee, roles: RoleDef[], cities: CityWithStores[]): string {
  if (emp.role === "admin" || emp.role === "owner") return "Все города";
  if (!emp.roleId) return "—";
  const role = roles.find((r) => r.id === emp.roleId);
  if (!role) return "—";
  const grants = role.role_store_access;
  if (grants.some((g) => g.scope === "all")) return "Все города";
  const names: string[] = [];
  for (const g of grants) {
    if (g.scope === "city") {
      const city = cities.find((c) => c.id === g.city_id);
      if (city) names.push(city.name);
    } else if (g.scope === "store") {
      for (const city of cities) {
        const store = city.stores.find((s) => s.id === g.store_id);
        if (store) names.push(store.name);
      }
    }
  }
  return names.length ? names.join(", ") : "Нет городов";
}

function PermissionsGrid({
  value,
  onChange,
  disabled = false,
}: {
  value: Permissions;
  onChange: (next: Permissions) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-[1fr_80px_80px] gap-2 text-[12.5px]">
      <div className="text-mutedLight uppercase text-[10.5px] tracking-wide">Раздел</div>
      <div className="text-mutedLight uppercase text-[10.5px] tracking-wide text-center">Просмотр</div>
      <div className="text-mutedLight uppercase text-[10.5px] tracking-wide text-center">Редактир.</div>
      {SECTIONS.map((s) => (
        <Fragment key={s.key}>
          <div className="py-1.5 border-t border-borderSoft">{s.label}</div>
          <div className="py-1.5 border-t border-borderSoft text-center">
            <input
              type="checkbox"
              checked={value[s.key].canView}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...value,
                  [s.key]: {
                    canView: e.target.checked,
                    canEdit: e.target.checked ? value[s.key].canEdit : false,
                  },
                })
              }
              className="accent-accent disabled:opacity-40"
            />
          </div>
          <div className="py-1.5 border-t border-borderSoft text-center">
            <input
              type="checkbox"
              checked={value[s.key].canEdit}
              disabled={disabled || !value[s.key].canView}
              onChange={(e) =>
                onChange({ ...value, [s.key]: { ...value[s.key], canEdit: e.target.checked } })
              }
              className="accent-accent disabled:opacity-40"
            />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function StoreAccessEditor({
  cities,
  value,
  onChange,
  disabled = false,
}: {
  cities: CityWithStores[];
  value: StoreAccessGrant[];
  onChange: (next: StoreAccessGrant[]) => void;
  disabled?: boolean;
}) {
  const isAll = value.some((g) => g.scope === "all");
  const cityIds = new Set(value.filter((g) => g.scope === "city").map((g) => g.cityId));

  function setAll(checked: boolean) {
    onChange(checked ? [{ scope: "all", cityId: null, storeId: null }] : []);
  }
  function toggleCity(cityId: number, checked: boolean) {
    const next = value.filter((g) => g.scope !== "all" && !(g.scope === "city" && g.cityId === cityId));
    onChange(checked ? [...next, { scope: "city", cityId, storeId: null }] : next);
  }

  return (
    <div className="flex flex-col gap-2 text-[12.5px]">
      <label className="flex items-center gap-2 font-semibold">
        <input
          type="checkbox"
          checked={isAll}
          disabled={disabled}
          onChange={(e) => setAll(e.target.checked)}
          className="accent-accent disabled:opacity-40"
        />
        Все города
      </label>
      {!isAll &&
        cities.map((city) => (
          <label key={city.id} className="flex items-center gap-2 pl-1">
            <input
              type="checkbox"
              checked={cityIds.has(city.id)}
              disabled={disabled}
              onChange={(e) => toggleCity(city.id, e.target.checked)}
              className="accent-accent disabled:opacity-40"
            />
            {city.name}
          </label>
        ))}
    </div>
  );
}

function EmployeeAccessPanel({
  role,
  cities,
  canEdit,
  onSave,
  onCancel,
  dirtyKey,
  onRegisterDirty,
  onUnregisterDirty,
}: {
  role: RoleDef | null;
  cities: CityWithStores[];
  canEdit: boolean;
  onSave: (permissions: Permissions, storeAccess: StoreAccessGrant[]) => Promise<void>;
  onCancel: () => void;
  dirtyKey: string;
  onRegisterDirty: (key: string, dirty: boolean, save: () => Promise<void>) => void;
  onUnregisterDirty: (key: string) => void;
}) {
  const [permissions, setPermissions] = useState<Permissions>(
    role ? toPermissions(role.role_permissions) : emptyPermissions()
  );
  const [storeAccess, setStoreAccess] = useState<StoreAccessGrant[]>(
    role ? toGrants(role.role_store_access) : []
  );
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const initialRef = useRef({ permissions, storeAccess });

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(permissions, storeAccess);
      setJustSaved(true);
      // Brief confirmation flash before the panel closes itself — same
      // save→saving→saved cycle as every other save button on this page.
      window.setTimeout(() => onCancel(), 900);
    } finally {
      setSaving(false);
    }
  }

  const dirty =
    canEdit &&
    (JSON.stringify(permissions) !== JSON.stringify(initialRef.current.permissions) ||
      JSON.stringify(storeAccess) !== JSON.stringify(initialRef.current.storeAccess));

  const { setGuard } = useUnsavedChanges();
  const saveRef = useRef(handleSave);
  saveRef.current = handleSave;

  useEffect(() => {
    setGuard(dirty, dirty ? { onSave: () => saveRef.current(), onDiscard: () => {} } : null);
    return () => setGuard(false, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  useEffect(() => {
    onRegisterDirty(dirtyKey, dirty, () => saveRef.current());
    return () => onUnregisterDirty(dirtyKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  return (
    <div className="pb-4 border-b border-borderSoft flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-2">
          <div className="text-[12px] font-semibold text-muted uppercase tracking-wide">Разделы портала</div>
          <PermissionsGrid value={permissions} onChange={setPermissions} disabled={!canEdit} />
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-[12px] font-semibold text-muted uppercase tracking-wide">Города</div>
          <StoreAccessEditor cities={cities} value={storeAccess} onChange={setStoreAccess} disabled={!canEdit} />
        </div>
      </div>
      {canEdit && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || justSaved}
            className="text-[12.5px] font-semibold text-paper bg-accent rounded-md px-3 py-1.5 disabled:opacity-50"
          >
            {saving ? "Сохраняем…" : justSaved ? "Сохранено" : "Сохранить"}
          </button>
          <button type="button" onClick={onCancel} className="text-[12.5px] text-muted">
            Отмена
          </button>
        </div>
      )}
    </div>
  );
}

export default function EmployeesPage() {
  const { email: myEmail, isAdmin, isOwner, permissions } = useAuth();
  const canView = isAdmin || permissions["settings.employees"].canView;
  const canEdit = isAdmin || permissions["settings.employees"].canEdit;
  const [tab, setTab] = useState<"employees" | "roles" | "stores">("employees");

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [cities, setCities] = useState<CityWithStores[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState("");
  const [accessEditingId, setAccessEditingId] = useState<string | null>(null);
  const [presence, setPresence] = useState<Record<string, string>>({});
  const [loginHistoryId, setLoginHistoryId] = useState<string | null>(null);
  const [loginEvents, setLoginEvents] = useState<Record<string, LoginEvent[]>>({});
  const [loginEventsLoading, setLoginEventsLoading] = useState(false);

  const [employeeEdits, setEmployeeEdits] = useState<
    Record<string, { fullName: string; email: string; roleChoice: string }>
  >({});
  const [cityEdits, setCityEdits] = useState<Record<number, string>>({});
  const [savingEmployeeId, setSavingEmployeeId] = useState<string | null>(null);
  const [justSavedEmployeeId, setJustSavedEmployeeId] = useState<string | null>(null);
  const [savingCityId, setSavingCityId] = useState<number | null>(null);
  const [justSavedCityId, setJustSavedCityId] = useState<number | null>(null);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [passwordJustSaved, setPasswordJustSaved] = useState(false);

  const sharedRoles = roles.filter((r) => !r.is_personal);

  const [newEmail, setNewEmail] = useState("");
  const [newFullName, setNewFullName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRoleChoice, setNewRoleChoice] = useState("admin"); // "admin" | "" | "<roleId>"
  const [creating, setCreating] = useState(false);

  const [newRoleName, setNewRoleName] = useState("");
  const [newRolePerms, setNewRolePerms] = useState<Permissions>(emptyPermissions());
  const [creatingRole, setCreatingRole] = useState(false);

  const [newCityName, setNewCityName] = useState("");
  const [creatingCity, setCreatingCity] = useState(false);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [employeesRes, rolesRes, citiesRes, presenceRes] = await Promise.all([
        authFetch("/api/employees"),
        authFetch("/api/roles"),
        authFetch("/api/cities"),
        supabase.from("user_presence").select("user_id, last_seen_at"),
      ]);
      setEmployees(employeesRes.employees);
      setRoles(rolesRes.roles);
      setCities(citiesRes.cities);
      const presenceMap: Record<string, string> = {};
      for (const row of presenceRes.data ?? []) presenceMap[row.user_id] = row.last_seen_at;
      setPresence(presenceMap);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить данные.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  function isOnline(emp: Employee) {
    const lastSeen = presence[emp.id];
    if (!lastSeen) return false;
    return Date.now() - new Date(lastSeen).getTime() < ONLINE_THRESHOLD_MS;
  }

  async function toggleLoginHistory(emp: Employee) {
    if (loginHistoryId === emp.id) {
      setLoginHistoryId(null);
      return;
    }
    setLoginHistoryId(emp.id);
    if (loginEvents[emp.id]) return;
    setLoginEventsLoading(true);
    try {
      const { data, error } = await supabase
        .from("user_login_events")
        .select("logged_in_at, user_agent")
        .eq("user_id", emp.id)
        .order("logged_in_at", { ascending: false })
        .limit(30);
      if (error) throw error;
      setLoginEvents((prev) => ({ ...prev, [emp.id]: (data ?? []) as LoginEvent[] }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить историю входа.");
    } finally {
      setLoginEventsLoading(false);
    }
  }

  function roleChoiceValue(emp: Employee) {
    if (emp.role === "owner") return "owner";
    if (emp.role === "admin") return "admin";
    if (emp.roleId) return String(emp.roleId);
    return "";
  }

  async function handleRoleChange(emp: Employee, value: string) {
    if (value === "owner") {
      if (!window.confirm(`Передать роль владельца ${emp.email}? Вы потеряете статус владельца и станете администратором.`)) {
        return;
      }
    }
    setError(null);
    const prevRole = emp.roleId ? roles.find((r) => r.id === emp.roleId) ?? null : null;
    try {
      await authFetch(`/api/employees/${emp.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          role: value === "admin" ? "admin" : value === "owner" ? "owner" : "custom",
          roleId: value === "admin" || value === "owner" || value === "" ? null : Number(value),
        }),
      });
      await loadAll();
      // The old role was a personal (per-employee) one and nobody uses it anymore — clean it up.
      if (prevRole?.is_personal && String(prevRole.id) !== value) {
        await authFetch(`/api/roles/${prevRole.id}`, { method: "DELETE" }).catch(() => {});
        await loadAll();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось изменить роль.");
    }
  }

  async function handleSaveEmployeeAccess(emp: Employee, perms: Permissions, storeAccess: StoreAccessGrant[]) {
    setError(null);
    const currentRole = emp.roleId ? roles.find((r) => r.id === emp.roleId) ?? null : null;
    try {
      if (currentRole?.is_personal) {
        await Promise.all([
          authFetch(`/api/roles/${currentRole.id}`, { method: "PATCH", body: JSON.stringify({ permissions: perms }) }),
          authFetch(`/api/roles/${currentRole.id}/store-access`, {
            method: "PATCH",
            body: JSON.stringify({ grants: storeAccess }),
          }),
        ]);
      } else {
        const created = await authFetch("/api/roles", {
          method: "POST",
          body: JSON.stringify({
            name: `personal:${emp.id}:${Date.now()}`,
            permissions: perms,
            isPersonal: true,
          }),
        });
        await authFetch(`/api/roles/${created.id}/store-access`, {
          method: "PATCH",
          body: JSON.stringify({ grants: storeAccess }),
        });
        await authFetch(`/api/employees/${emp.id}`, {
          method: "PATCH",
          body: JSON.stringify({ role: "custom", roleId: created.id }),
        });
      }
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить права доступа.");
    }
  }

  async function handleRenameEmployee(emp: Employee, fullName: string) {
    setError(null);
    try {
      await authFetch(`/api/employees/${emp.id}`, { method: "PATCH", body: JSON.stringify({ fullName }) });
      setEmployees((prev) => prev.map((e) => (e.id === emp.id ? { ...e, fullName: fullName.trim() || null } : e)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось изменить имя.");
    }
  }

  async function handleUpdateEmail(emp: Employee, email: string) {
    if (!email.trim() || email.trim() === emp.email) return;
    setError(null);
    try {
      await authFetch(`/api/employees/${emp.id}`, { method: "PATCH", body: JSON.stringify({ email: email.trim() }) });
      setEmployees((prev) => prev.map((e) => (e.id === emp.id ? { ...e, email: email.trim() } : e)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось изменить email.");
    }
  }

  function getEditedFullName(emp: Employee) {
    return employeeEdits[emp.id]?.fullName ?? emp.fullName ?? "";
  }
  function getEditedEmail(emp: Employee) {
    return employeeEdits[emp.id]?.email ?? emp.email;
  }
  function getEditedRoleChoice(emp: Employee) {
    return employeeEdits[emp.id]?.roleChoice ?? roleChoiceValue(emp);
  }
  function isEmployeeDirty(emp: Employee) {
    const edit = employeeEdits[emp.id];
    if (!edit) return false;
    return (
      edit.fullName !== (emp.fullName ?? "") ||
      edit.email !== emp.email ||
      edit.roleChoice !== roleChoiceValue(emp)
    );
  }
  function updateEmployeeEdit(
    emp: Employee,
    patch: Partial<{ fullName: string; email: string; roleChoice: string }>
  ) {
    setEmployeeEdits((prev) => ({
      ...prev,
      [emp.id]: {
        fullName: patch.fullName ?? prev[emp.id]?.fullName ?? emp.fullName ?? "",
        email: patch.email ?? prev[emp.id]?.email ?? emp.email,
        roleChoice: patch.roleChoice ?? prev[emp.id]?.roleChoice ?? roleChoiceValue(emp),
      },
    }));
  }
  function discardEmployeeEdit(emp: Employee) {
    setEmployeeEdits((prev) => {
      const next = { ...prev };
      delete next[emp.id];
      return next;
    });
  }
  async function handleSaveEmployeeEdit(emp: Employee) {
    const edit = employeeEdits[emp.id];
    if (!edit) return;
    setSavingEmployeeId(emp.id);
    try {
      if (edit.fullName !== (emp.fullName ?? "")) await handleRenameEmployee(emp, edit.fullName);
      if (edit.email !== emp.email) await handleUpdateEmail(emp, edit.email);
      if (edit.roleChoice !== roleChoiceValue(emp)) await handleRoleChange(emp, edit.roleChoice);
      discardEmployeeEdit(emp);
      setJustSavedEmployeeId(emp.id);
      window.setTimeout(() => setJustSavedEmployeeId((id) => (id === emp.id ? null : id)), 1200);
    } finally {
      setSavingEmployeeId(null);
    }
  }

  function isCityDirty(city: CityWithStores) {
    const edit = cityEdits[city.id];
    return edit !== undefined && edit.trim() !== "" && edit !== city.name;
  }
  function discardCityEdit(cityId: number) {
    setCityEdits((prev) => {
      const next = { ...prev };
      delete next[cityId];
      return next;
    });
  }
  async function handleSaveCityEdit(city: CityWithStores) {
    const edit = cityEdits[city.id];
    if (edit === undefined || edit.trim() === "" || edit === city.name) return;
    setSavingCityId(city.id);
    try {
      await handleRenameCity(city.id, edit);
      discardCityEdit(city.id);
      setJustSavedCityId(city.id);
      window.setTimeout(() => setJustSavedCityId((id) => (id === city.id ? null : id)), 1200);
    } finally {
      setSavingCityId(null);
    }
  }

  async function handleResetPassword(emp: Employee, password: string) {
    if (password.length < 6) {
      setError("Пароль должен быть не короче 6 символов.");
      return;
    }
    setError(null);
    setResettingPassword(true);
    try {
      await authFetch(`/api/employees/${emp.id}`, { method: "PATCH", body: JSON.stringify({ password }) });
      setPasswordJustSaved(true);
      window.setTimeout(() => {
        setResettingId(null);
        setResetPasswordValue("");
        setPasswordJustSaved(false);
      }, 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сбросить пароль.");
    } finally {
      setResettingPassword(false);
    }
  }

  async function handleDeleteEmployee(emp: Employee) {
    if (!window.confirm(`Удалить сотрудника ${emp.email}? Это действие нельзя отменить.`)) return;
    setError(null);
    try {
      await authFetch(`/api/employees/${emp.id}`, { method: "DELETE" });
      setEmployees((prev) => prev.filter((e) => e.id !== emp.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось удалить сотрудника.");
    }
  }

  async function handleCreateEmployee(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const created = await authFetch("/api/employees", {
        method: "POST",
        body: JSON.stringify({
          email: newEmail,
          password: newPassword,
          fullName: newFullName,
          role: newRoleChoice === "admin" ? "admin" : "custom",
          roleId: newRoleChoice === "admin" || newRoleChoice === "" ? null : Number(newRoleChoice),
        }),
      });
      setEmployees((prev) => [
        ...prev,
        {
          id: created.id,
          email: created.email,
          fullName: created.fullName,
          role: newRoleChoice === "admin" ? "admin" : "editor",
          roleId: newRoleChoice === "admin" || newRoleChoice === "" ? null : Number(newRoleChoice),
        },
      ]);
      setNewEmail("");
      setNewFullName("");
      setNewPassword("");
      setNewRoleChoice("admin");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось создать сотрудника.");
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveRole(role: RoleDef, name: string, permissions: Permissions, storeAccess: StoreAccessGrant[]) {
    setError(null);
    try {
      await Promise.all([
        authFetch(`/api/roles/${role.id}`, { method: "PATCH", body: JSON.stringify({ name, permissions }) }),
        authFetch(`/api/roles/${role.id}/store-access`, {
          method: "PATCH",
          body: JSON.stringify({ grants: storeAccess }),
        }),
      ]);
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить роль.");
    }
  }

  async function handleDeleteRole(role: RoleDef) {
    if (!window.confirm(`Удалить роль «${role.name}»?`)) return;
    setError(null);
    try {
      await authFetch(`/api/roles/${role.id}`, { method: "DELETE" });
      setRoles((prev) => prev.filter((r) => r.id !== role.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось удалить роль.");
    }
  }

  async function handleCreateRole(e: React.FormEvent) {
    e.preventDefault();
    setCreatingRole(true);
    setError(null);
    try {
      await authFetch("/api/roles", {
        method: "POST",
        body: JSON.stringify({ name: newRoleName, permissions: newRolePerms }),
      });
      setNewRoleName("");
      setNewRolePerms(emptyPermissions());
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось создать роль.");
    } finally {
      setCreatingRole(false);
    }
  }

  async function handleCreateCity(e: React.FormEvent) {
    e.preventDefault();
    setCreatingCity(true);
    setError(null);
    try {
      await authFetch("/api/cities", { method: "POST", body: JSON.stringify({ name: newCityName }) });
      setNewCityName("");
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось создать город.");
    } finally {
      setCreatingCity(false);
    }
  }

  async function handleRenameCity(cityId: number, name: string) {
    setError(null);
    try {
      await authFetch(`/api/cities/${cityId}`, { method: "PATCH", body: JSON.stringify({ name }) });
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось переименовать город.");
    }
  }

  async function handleDeleteCity(city: CityWithStores) {
    if (!window.confirm(`Удалить город «${city.name}»? Уже сохранённые данные за прошлые дни останутся в базе.`)) return;
    setError(null);
    try {
      await authFetch(`/api/cities/${city.id}`, { method: "DELETE" });
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось удалить город.");
    }
  }

  // EmployeeAccessPanel (per-employee "Права") and RoleCard (per-role) each
  // track their own dirty state locally — this registry lets them report it
  // up so the page-wide Сохранить button (and anyDirty below) actually sees
  // it, instead of only knowing about employee-row and city-name edits.
  const dirtyRegistry = useRef<Map<string, boolean>>(new Map());
  const saveRegistry = useRef<Map<string, () => Promise<void>>>(new Map());
  const [registryTick, setRegistryTick] = useState(0);

  function registerDirty(key: string, isDirty: boolean, save: () => Promise<void>) {
    saveRegistry.current.set(key, save);
    if (dirtyRegistry.current.get(key) !== isDirty) {
      dirtyRegistry.current.set(key, isDirty);
      setRegistryTick((v) => v + 1);
    }
  }
  function unregisterDirty(key: string) {
    saveRegistry.current.delete(key);
    if (dirtyRegistry.current.delete(key)) setRegistryTick((v) => v + 1);
  }
  const registryDirty = [...dirtyRegistry.current.values()].some(Boolean);

  const anyDirty = employees.some(isEmployeeDirty) || cities.some(isCityDirty) || registryDirty;

  async function saveAllDirty() {
    for (const emp of employees) {
      if (isEmployeeDirty(emp)) await handleSaveEmployeeEdit(emp);
    }
    for (const city of cities) {
      if (isCityDirty(city)) await handleSaveCityEdit(city);
    }
    for (const [key, isDirty] of dirtyRegistry.current) {
      if (isDirty) await saveRegistry.current.get(key)?.();
    }
  }

  function discardAllDirty() {
    setEmployeeEdits({});
    setCityEdits({});
  }

  const [savingAll, setSavingAll] = useState(false);
  const [justSavedAll, setJustSavedAll] = useState(false);

  async function handleSaveAll() {
    setSavingAll(true);
    try {
      await saveAllDirty();
      setJustSavedAll(true);
      window.setTimeout(() => setJustSavedAll(false), 1200);
    } finally {
      setSavingAll(false);
    }
  }

  const { setGuard, requestNavigation } = useUnsavedChanges();
  const saveAllRef = useRef(saveAllDirty);
  saveAllRef.current = saveAllDirty;
  const discardAllRef = useRef(discardAllDirty);
  discardAllRef.current = discardAllDirty;

  useEffect(() => {
    setGuard(anyDirty, anyDirty ? { onSave: () => saveAllRef.current(), onDiscard: () => discardAllRef.current() } : null);
    return () => setGuard(false, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyDirty]);

  function changeTab(t: "employees" | "roles" | "stores") {
    if (t === tab) return;
    requestNavigation(() => setTab(t));
  }

  if (!canView) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Сотрудники и доступы».</p>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Настройки</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">Сотрудники и доступы</h1>
        <p className="text-sm text-muted max-w-xl mt-1">
          Создавайте сотрудников и роли с гибким доступом: для каждого раздела портала и точки
          продаж можно отдельно разрешить просмотр и редактирование.
        </p>
        {error && <p className="text-sm text-[#A34B36]">{error}</p>}
      </div>

      <div className="flex items-center gap-1.5 bg-surface border border-border rounded-card p-1.5 w-fit">
        {(["employees", "roles", "stores"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => changeTab(t)}
            className={`text-[13px] rounded-md px-3.5 py-2 ${
              tab === t ? "bg-accent text-paper font-bold" : "text-muted font-medium"
            }`}
          >
            {t === "employees" ? "Сотрудники" : t === "roles" ? "Роли доступа" : "Города"}
          </button>
        ))}
        <div className="w-px h-5 bg-border mx-0.5" />
        <button
          type="button"
          onClick={handleSaveAll}
          disabled={!anyDirty || savingAll}
          className={`text-[13px] font-bold rounded-md px-3.5 py-2 transition-colors ${
            anyDirty && !savingAll ? "bg-accent text-paper" : "bg-[#C9C9C9] text-[#8A8A8A] cursor-not-allowed"
          }`}
        >
          {savingAll ? "Сохраняем…" : justSavedAll ? "Сохранено" : "Сохранить"}
        </button>
      </div>

      {loading ? (
        <div className="text-sm text-muted">Загрузка…</div>
      ) : tab === "employees" ? (
        <div className="flex flex-col gap-4">
          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            <div className="text-[15px] font-bold">Список сотрудников</div>
            <div className="grid grid-cols-[1fr_1fr_1fr_150px_150px] gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
              <div>Имя</div>
              <div>Email</div>
              <div>Города</div>
              <div>Роль</div>
              <div></div>
            </div>
            {employees.map((emp) => (
              <Fragment key={emp.id}>
                <div className="grid grid-cols-[1fr_1fr_1fr_150px_150px] gap-3 py-2.5 border-b border-borderSoft items-center text-[13px]">
                  <div className="flex flex-col gap-1">
                    <input
                      type="text"
                      value={getEditedFullName(emp)}
                      placeholder="Без имени"
                      disabled={!canEdit}
                      onChange={(e) => updateEmployeeEdit(emp, { fullName: e.target.value })}
                      className="border border-border rounded-md px-2 py-1.5 text-[12.5px] disabled:opacity-50"
                    />
                    <div className="flex items-center gap-1.5 text-[10.5px] text-mutedLight pl-0.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${isOnline(emp) ? "bg-[#3E6B44]" : "bg-mutedLight"}`} />
                      {isOnline(emp) ? "Онлайн" : "Оффлайн"}
                    </div>
                  </div>
                  <input
                    type="email"
                    value={getEditedEmail(emp)}
                    disabled={!canEdit}
                    onChange={(e) => updateEmployeeEdit(emp, { email: e.target.value })}
                    className="border border-border rounded-md px-2 py-1.5 text-[12.5px] disabled:opacity-50"
                  />
                  <div className="text-muted text-[12px] truncate" title={resolveStoreLabel(emp, roles, cities)}>
                    {resolveStoreLabel(emp, roles, cities)}
                  </div>
                  <select
                    value={getEditedRoleChoice(emp)}
                    onChange={(e) => updateEmployeeEdit(emp, { roleChoice: e.target.value })}
                    disabled={emp.email === myEmail || !canEdit || (emp.role === "owner" && !isOwner)}
                    className="border border-border rounded-md px-2 py-1.5 text-[12.5px] disabled:opacity-50"
                  >
                    {(isOwner || emp.role === "owner") && <option value="owner">Владелец</option>}
                    <option value="admin">Администратор</option>
                    <option value="">Без роли</option>
                    {sharedRoles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                    {(() => {
                      const current = emp.roleId ? roles.find((r) => r.id === emp.roleId) : null;
                      return current?.is_personal ? (
                        <option value={current.id}>Личный доступ</option>
                      ) : null;
                    })()}
                  </select>
                  <div className="flex flex-col gap-1">
                    {isEmployeeDirty(emp) ? (
                      <>
                        <button
                          type="button"
                          onClick={() => handleSaveEmployeeEdit(emp)}
                          disabled={savingEmployeeId === emp.id}
                          className="text-[12px] text-accent font-bold text-left disabled:opacity-50"
                        >
                          {savingEmployeeId === emp.id ? "Сохраняем…" : "Сохранить"}
                        </button>
                        <button
                          type="button"
                          onClick={() => discardEmployeeEdit(emp)}
                          className="text-[12px] text-muted text-left"
                        >
                          Отмена
                        </button>
                      </>
                    ) : justSavedEmployeeId === emp.id ? (
                      <span className="text-[12px] text-accent font-bold">Сохранено</span>
                    ) : (
                      <>
                        {emp.role !== "owner" && (
                          <button
                            type="button"
                            onClick={() => setAccessEditingId(accessEditingId === emp.id ? null : emp.id)}
                            className="text-[12px] text-accent font-semibold text-left"
                          >
                            Права
                          </button>
                        )}
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => {
                              setResettingId(resettingId === emp.id ? null : emp.id);
                              setResetPasswordValue("");
                            }}
                            className="text-[12px] text-accent font-semibold text-left"
                          >
                            Пароль
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleLoginHistory(emp)}
                          className="text-[12px] text-accent font-semibold text-left"
                        >
                          История входа
                        </button>
                        <button
                          type="button"
                          disabled={emp.email === myEmail || emp.role === "owner" || !canEdit}
                          onClick={() => handleDeleteEmployee(emp)}
                          title={emp.role === "owner" ? "Владельца нельзя удалить" : undefined}
                          className="text-[12px] text-[#A34B36] font-semibold disabled:opacity-40 text-left"
                        >
                          Удалить
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {loginHistoryId === emp.id && (
                  <div className="pb-3 border-b border-borderSoft flex flex-col gap-1.5">
                    <div className="text-[11px] uppercase tracking-wide text-mutedLight">История входа</div>
                    {loginEventsLoading && !loginEvents[emp.id] ? (
                      <div className="text-[12.5px] text-muted">Загрузка…</div>
                    ) : (loginEvents[emp.id] ?? []).length === 0 ? (
                      <div className="text-[12.5px] text-muted">Входов пока не зафиксировано.</div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {(loginEvents[emp.id] ?? []).map((ev, i) => (
                          <div key={i} className="flex items-center gap-3 text-[12.5px]">
                            <span className="text-ink font-medium">{formatDateTime(ev.logged_in_at)}</span>
                            <span className="text-muted">{parseUserAgent(ev.user_agent)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {accessEditingId === emp.id && (
                  <EmployeeAccessPanel
                    role={emp.roleId ? roles.find((r) => r.id === emp.roleId) ?? null : null}
                    cities={cities}
                    canEdit={canEdit}
                    onSave={(perms, storeAccess) => handleSaveEmployeeAccess(emp, perms, storeAccess)}
                    onCancel={() => setAccessEditingId(null)}
                    dirtyKey={`access:${emp.id}`}
                    onRegisterDirty={registerDirty}
                    onUnregisterDirty={unregisterDirty}
                  />
                )}
                {resettingId === emp.id && canEdit && (
                  <div className="flex items-center gap-2 pb-2.5 border-b border-borderSoft">
                    <input
                      type="text"
                      autoFocus
                      placeholder="Новый пароль (мин. 6 символов)"
                      value={resetPasswordValue}
                      onChange={(e) => setResetPasswordValue(e.target.value)}
                      className="border border-border rounded-md px-2 py-1.5 text-[12.5px] max-w-xs"
                    />
                    <button
                      type="button"
                      onClick={() => handleResetPassword(emp, resetPasswordValue)}
                      disabled={resettingPassword || passwordJustSaved}
                      className="text-[12.5px] font-semibold text-paper bg-accent rounded-md px-3 py-1.5 disabled:opacity-50"
                    >
                      {resettingPassword ? "Сохраняем…" : passwordJustSaved ? "Сохранено" : "Сохранить пароль"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setResettingId(null)}
                      className="text-[12.5px] text-muted"
                    >
                      Отмена
                    </button>
                  </div>
                )}
              </Fragment>
            ))}
          </div>

          {canEdit && (
          <form
            onSubmit={handleCreateEmployee}
            className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5"
          >
            <div className="text-[15px] font-bold">Добавить сотрудника</div>
            <div className="grid grid-cols-4 gap-3">
              <input
                type="text"
                placeholder="Имя (необязательно)"
                value={newFullName}
                onChange={(e) => setNewFullName(e.target.value)}
                className="border border-border rounded-lg px-3 py-2.5 text-sm"
              />
              <input
                type="email"
                required
                placeholder="Email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                className="border border-border rounded-lg px-3 py-2.5 text-sm"
              />
              <input
                type="text"
                required
                minLength={6}
                placeholder="Пароль (мин. 6 символов)"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="border border-border rounded-lg px-3 py-2.5 text-sm"
              />
              <select
                value={newRoleChoice}
                onChange={(e) => setNewRoleChoice(e.target.value)}
                className="border border-border rounded-lg px-3 py-2.5 text-sm"
              >
                <option value="admin">Администратор</option>
                <option value="">Без роли</option>
                {sharedRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={creating}
              className="self-start text-[13px] font-bold text-paper bg-accent rounded-lg px-[18px] py-2.5 disabled:opacity-50"
            >
              {creating ? "Создаём…" : "Создать сотрудника"}
            </button>
          </form>
          )}
        </div>
      ) : tab === "roles" ? (
        <div className="flex flex-col gap-4">
          {sharedRoles.map((role) => (
            <RoleCard
              key={role.id}
              role={role}
              cities={cities}
              onSave={handleSaveRole}
              onDelete={handleDeleteRole}
              canEdit={canEdit}
              onRegisterDirty={registerDirty}
              onUnregisterDirty={unregisterDirty}
            />
          ))}

          {canEdit && (
          <form
            onSubmit={handleCreateRole}
            className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5"
          >
            <div className="text-[15px] font-bold">Создать новую роль</div>
            <input
              type="text"
              required
              placeholder="Название роли (например, «Маркетолог»)"
              value={newRoleName}
              onChange={(e) => setNewRoleName(e.target.value)}
              className="border border-border rounded-lg px-3 py-2.5 text-sm max-w-sm"
            />
            <PermissionsGrid value={newRolePerms} onChange={setNewRolePerms} />
            <p className="text-[12px] text-muted">
              Доступ по городам настраивается после создания роли — откройте её карточку ниже.
            </p>
            <button
              type="submit"
              disabled={creatingRole}
              className="self-start text-[13px] font-bold text-paper bg-accent rounded-lg px-[18px] py-2.5 disabled:opacity-50"
            >
              {creatingRole ? "Создаём…" : "Создать роль"}
            </button>
          </form>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {cities.map((city) => (
            <div key={city.id} className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={cityEdits[city.id] ?? city.name}
                  disabled={!canEdit}
                  onChange={(e) => setCityEdits((prev) => ({ ...prev, [city.id]: e.target.value }))}
                  className="border border-border rounded-lg px-3 py-2 text-sm font-bold flex-1 max-w-sm disabled:opacity-50"
                />
                {canEdit && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleSaveCityEdit(city)}
                      disabled={!isCityDirty(city) || savingCityId === city.id}
                      className={`text-[13px] font-bold rounded-md px-3 py-1.5 transition-colors ${
                        isCityDirty(city) && savingCityId !== city.id
                          ? "bg-accent text-paper"
                          : "bg-[#C9C9C9] text-[#8A8A8A] cursor-not-allowed"
                      }`}
                    >
                      {savingCityId === city.id ? "Сохраняем…" : justSavedCityId === city.id ? "Сохранено" : "Сохранить"}
                    </button>
                    {isCityDirty(city) ? (
                      <button type="button" onClick={() => discardCityEdit(city.id)} className="text-[13px] text-muted">
                        Отмена
                      </button>
                    ) : (
                      justSavedCityId !== city.id && (
                        <button
                          type="button"
                          onClick={() => handleDeleteCity(city)}
                          className="text-[13px] text-[#A34B36] font-semibold"
                        >
                          Удалить город
                        </button>
                      )
                    )}
                  </>
                )}
              </div>
            </div>
          ))}

          {canEdit && (
          <form
            onSubmit={handleCreateCity}
            className="bg-surface border border-border rounded-card px-6 py-[22px] flex items-center gap-3"
          >
            <input
              type="text"
              required
              placeholder="Название нового города"
              value={newCityName}
              onChange={(e) => setNewCityName(e.target.value)}
              className="border border-border rounded-lg px-3 py-2.5 text-sm flex-1 max-w-sm"
            />
            <button
              type="submit"
              disabled={creatingCity}
              className="text-[13px] font-bold text-paper bg-accent rounded-lg px-[18px] py-2.5 disabled:opacity-50"
            >
              {creatingCity ? "Создаём…" : "Добавить город"}
            </button>
          </form>
          )}
        </div>
      )}
    </>
  );
}

function RoleCard({
  role,
  cities,
  onSave,
  onDelete,
  canEdit,
  onRegisterDirty,
  onUnregisterDirty,
}: {
  role: RoleDef;
  cities: CityWithStores[];
  onSave: (role: RoleDef, name: string, permissions: Permissions, storeAccess: StoreAccessGrant[]) => Promise<void>;
  onDelete: (role: RoleDef) => Promise<void>;
  canEdit: boolean;
  onRegisterDirty: (key: string, dirty: boolean, save: () => Promise<void>) => void;
  onUnregisterDirty: (key: string) => void;
}) {
  const [name, setName] = useState(role.name);
  const [permissions, setPermissions] = useState<Permissions>(toPermissions(role.role_permissions));
  const [storeAccess, setStoreAccess] = useState<StoreAccessGrant[]>(toGrants(role.role_store_access));
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(role, name, permissions, storeAccess);
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 1200);
    } finally {
      setSaving(false);
    }
  }

  function discardEdits() {
    setName(role.name);
    setPermissions(toPermissions(role.role_permissions));
    setStoreAccess(toGrants(role.role_store_access));
  }

  const dirty =
    canEdit &&
    (name !== role.name ||
      JSON.stringify(permissions) !== JSON.stringify(toPermissions(role.role_permissions)) ||
      JSON.stringify(storeAccess) !== JSON.stringify(toGrants(role.role_store_access)));

  const { setGuard } = useUnsavedChanges();
  const saveRef = useRef(handleSave);
  saveRef.current = handleSave;
  const discardRef = useRef(discardEdits);
  discardRef.current = discardEdits;

  useEffect(() => {
    setGuard(dirty, dirty ? { onSave: () => saveRef.current(), onDiscard: () => discardRef.current() } : null);
    return () => setGuard(false, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const dirtyKey = `role:${role.id}`;
  useEffect(() => {
    onRegisterDirty(dirtyKey, dirty, () => saveRef.current());
    return () => onUnregisterDirty(dirtyKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  return (
    <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={name}
          disabled={!canEdit}
          onChange={(e) => setName(e.target.value)}
          className="border border-border rounded-lg px-3 py-2 text-sm font-bold flex-1 max-w-sm disabled:opacity-50"
        />
        {canEdit && (
          <>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="text-[13px] font-bold text-paper bg-accent rounded-lg px-4 py-2 disabled:opacity-50"
            >
              {saving ? "Сохраняем…" : justSaved ? "Сохранено" : "Сохранить"}
            </button>
            <button
              type="button"
              onClick={() => onDelete(role)}
              className="text-[13px] text-[#A34B36] font-semibold"
            >
              Удалить
            </button>
          </>
        )}
      </div>
      <div className="grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-2">
          <div className="text-[12px] font-semibold text-muted uppercase tracking-wide">Разделы портала</div>
          <PermissionsGrid value={permissions} onChange={setPermissions} disabled={!canEdit} />
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-[12px] font-semibold text-muted uppercase tracking-wide">Города</div>
          <StoreAccessEditor cities={cities} value={storeAccess} onChange={setStoreAccess} disabled={!canEdit} />
        </div>
      </div>
    </div>
  );
}
