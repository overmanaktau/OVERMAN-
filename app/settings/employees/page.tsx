"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/apiClient";
import { SECTIONS, emptyPermissions, type Permissions } from "@/lib/permissions";
import { useAuth } from "@/components/AuthGate";
import { useUnsavedChanges } from "@/components/UnsavedChangesContext";

type Employee = {
  id: string;
  email: string;
  fullName: string | null;
  role: "admin" | "editor" | null;
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
  if (emp.role === "admin") return "Все точки";
  if (!emp.roleId) return "—";
  const role = roles.find((r) => r.id === emp.roleId);
  if (!role) return "—";
  const grants = role.role_store_access;
  if (grants.some((g) => g.scope === "all")) return "Все точки";
  const names: string[] = [];
  for (const g of grants) {
    if (g.scope === "city") {
      const city = cities.find((c) => c.id === g.city_id);
      if (city) names.push(`${city.name} (весь)`);
    } else if (g.scope === "store") {
      for (const city of cities) {
        const store = city.stores.find((s) => s.id === g.store_id);
        if (store) names.push(store.name);
      }
    }
  }
  return names.length ? names.join(", ") : "Нет точек";
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
  const storeIds = new Set(value.filter((g) => g.scope === "store").map((g) => g.storeId));

  function setAll(checked: boolean) {
    onChange(checked ? [{ scope: "all", cityId: null, storeId: null }] : []);
  }
  function toggleCity(cityId: number, checked: boolean) {
    // Also drop any individual store grants for this city's stores — otherwise a
    // leftover per-store entry keeps that checkbox checked even after the city
    // box is unchecked (or stays redundantly checked once the city box is checked).
    const cityStoreIds = new Set(cities.find((c) => c.id === cityId)?.stores.map((s) => s.id) ?? []);
    const next = value.filter(
      (g) =>
        g.scope !== "all" &&
        !(g.scope === "city" && g.cityId === cityId) &&
        !(g.scope === "store" && cityStoreIds.has(g.storeId as number))
    );
    onChange(checked ? [...next, { scope: "city", cityId, storeId: null }] : next);
  }
  function toggleStore(storeId: number, checked: boolean) {
    const next = value.filter((g) => g.scope !== "all" && !(g.scope === "store" && g.storeId === storeId));
    onChange(checked ? [...next, { scope: "store", cityId: null, storeId }] : next);
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
        Все города и точки
      </label>
      {!isAll &&
        cities.map((city) => {
          const cityChecked = cityIds.has(city.id);
          return (
            <div key={city.id} className="flex flex-col gap-1 pl-1">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={cityChecked}
                  disabled={disabled}
                  onChange={(e) => toggleCity(city.id, e.target.checked)}
                  className="accent-accent disabled:opacity-40"
                />
                {city.name} <span className="text-mutedLight">(весь город)</span>
              </label>
              <div className="flex flex-col gap-1 pl-6">
                {city.stores.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-muted">
                    <input
                      type="checkbox"
                      checked={cityChecked || storeIds.has(s.id)}
                      disabled={disabled || cityChecked}
                      onChange={(e) => toggleStore(s.id, e.target.checked)}
                      className="accent-accent disabled:opacity-50"
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
    </div>
  );
}

function EmployeeAccessPanel({
  role,
  cities,
  canEdit,
  onSave,
  onCancel,
}: {
  role: RoleDef | null;
  cities: CityWithStores[];
  canEdit: boolean;
  onSave: (permissions: Permissions, storeAccess: StoreAccessGrant[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [permissions, setPermissions] = useState<Permissions>(
    role ? toPermissions(role.role_permissions) : emptyPermissions()
  );
  const [storeAccess, setStoreAccess] = useState<StoreAccessGrant[]>(
    role ? toGrants(role.role_store_access) : []
  );
  const [saving, setSaving] = useState(false);
  const initialRef = useRef({ permissions, storeAccess });

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(permissions, storeAccess);
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

  return (
    <div className="pb-4 border-b border-borderSoft flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-2">
          <div className="text-[12px] font-semibold text-muted uppercase tracking-wide">Разделы портала</div>
          <PermissionsGrid value={permissions} onChange={setPermissions} disabled={!canEdit} />
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-[12px] font-semibold text-muted uppercase tracking-wide">Точки продаж</div>
          <StoreAccessEditor cities={cities} value={storeAccess} onChange={setStoreAccess} disabled={!canEdit} />
        </div>
      </div>
      {canEdit && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="text-[12.5px] font-semibold text-paper bg-accent rounded-md px-3 py-1.5 disabled:opacity-50"
          >
            {saving ? "Сохраняем…" : "Сохранить"}
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
  const { email: myEmail, isAdmin, permissions } = useAuth();
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

  const [employeeEdits, setEmployeeEdits] = useState<
    Record<string, { fullName: string; email: string; roleChoice: string }>
  >({});
  const [cityEdits, setCityEdits] = useState<Record<number, string>>({});
  const [storeEdits, setStoreEdits] = useState<Record<number, string>>({});

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
  const [newStoreName, setNewStoreName] = useState<Record<number, string>>({});
  const [newStoreCode, setNewStoreCode] = useState<Record<number, string>>({});

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [employeesRes, rolesRes, citiesRes] = await Promise.all([
        authFetch("/api/employees"),
        authFetch("/api/roles"),
        authFetch("/api/cities"),
      ]);
      setEmployees(employeesRes.employees);
      setRoles(rolesRes.roles);
      setCities(citiesRes.cities);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить данные.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  function roleChoiceValue(emp: Employee) {
    if (emp.role === "admin") return "admin";
    if (emp.roleId) return String(emp.roleId);
    return "";
  }

  async function handleRoleChange(emp: Employee, value: string) {
    setError(null);
    const prevRole = emp.roleId ? roles.find((r) => r.id === emp.roleId) ?? null : null;
    try {
      await authFetch(`/api/employees/${emp.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          role: value === "admin" ? "admin" : "custom",
          roleId: value === "admin" || value === "" ? null : Number(value),
        }),
      });
      setEmployees((prev) =>
        prev.map((e) =>
          e.id === emp.id
            ? { ...e, role: value === "admin" ? "admin" : "editor", roleId: value === "admin" || value === "" ? null : Number(value) }
            : e
        )
      );
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
      setAccessEditingId(null);
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
    if (edit.fullName !== (emp.fullName ?? "")) await handleRenameEmployee(emp, edit.fullName);
    if (edit.email !== emp.email) await handleUpdateEmail(emp, edit.email);
    if (edit.roleChoice !== roleChoiceValue(emp)) await handleRoleChange(emp, edit.roleChoice);
    discardEmployeeEdit(emp);
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
    await handleRenameCity(city.id, edit);
    discardCityEdit(city.id);
  }

  function isStoreDirty(store: { id: number; name: string }) {
    const edit = storeEdits[store.id];
    return edit !== undefined && edit.trim() !== "" && edit !== store.name;
  }
  function discardStoreEdit(storeId: number) {
    setStoreEdits((prev) => {
      const next = { ...prev };
      delete next[storeId];
      return next;
    });
  }
  async function handleSaveStoreEdit(store: { id: number; name: string }) {
    const edit = storeEdits[store.id];
    if (edit === undefined || edit.trim() === "" || edit === store.name) return;
    await handleRenameStore(store.id, edit);
    discardStoreEdit(store.id);
  }

  async function handleResetPassword(emp: Employee, password: string) {
    if (password.length < 6) {
      setError("Пароль должен быть не короче 6 символов.");
      return;
    }
    setError(null);
    try {
      await authFetch(`/api/employees/${emp.id}`, { method: "PATCH", body: JSON.stringify({ password }) });
      setResettingId(null);
      setResetPasswordValue("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сбросить пароль.");
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
    if (!window.confirm(`Удалить город «${city.name}» вместе со всеми его точками?`)) return;
    setError(null);
    try {
      await authFetch(`/api/cities/${city.id}`, { method: "DELETE" });
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось удалить город.");
    }
  }

  async function handleCreateStore(cityId: number) {
    const name = newStoreName[cityId]?.trim();
    const code = newStoreCode[cityId]?.trim();
    if (!name || !code) return;
    setError(null);
    try {
      await authFetch("/api/stores", { method: "POST", body: JSON.stringify({ cityId, name, code }) });
      setNewStoreName((prev) => ({ ...prev, [cityId]: "" }));
      setNewStoreCode((prev) => ({ ...prev, [cityId]: "" }));
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось создать точку.");
    }
  }

  async function handleRenameStore(storeId: number, name: string) {
    setError(null);
    try {
      await authFetch(`/api/stores/${storeId}`, { method: "PATCH", body: JSON.stringify({ name }) });
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось переименовать точку.");
    }
  }

  async function handleDeleteStore(store: { id: number; name: string }) {
    if (!window.confirm(`Удалить точку «${store.name}»? Уже сохранённые данные за прошлые дни останутся в базе.`)) return;
    setError(null);
    try {
      await authFetch(`/api/stores/${store.id}`, { method: "DELETE" });
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось удалить точку.");
    }
  }

  const anyDirty =
    employees.some(isEmployeeDirty) ||
    cities.some(isCityDirty) ||
    cities.some((c) => c.stores.some(isStoreDirty));

  async function saveAllDirty() {
    for (const emp of employees) {
      if (isEmployeeDirty(emp)) await handleSaveEmployeeEdit(emp);
    }
    for (const city of cities) {
      if (isCityDirty(city)) await handleSaveCityEdit(city);
      for (const s of city.stores) {
        if (isStoreDirty(s)) await handleSaveStoreEdit(s);
      }
    }
  }

  function discardAllDirty() {
    setEmployeeEdits({});
    setCityEdits({});
    setStoreEdits({});
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
            {t === "employees" ? "Сотрудники" : t === "roles" ? "Роли доступа" : "Города и точки"}
          </button>
        ))}
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
              <div>Точки</div>
              <div>Роль</div>
              <div></div>
            </div>
            {employees.map((emp) => (
              <Fragment key={emp.id}>
                <div className="grid grid-cols-[1fr_1fr_1fr_150px_150px] gap-3 py-2.5 border-b border-borderSoft items-center text-[13px]">
                  <input
                    type="text"
                    value={getEditedFullName(emp)}
                    placeholder="Без имени"
                    disabled={!canEdit}
                    onChange={(e) => updateEmployeeEdit(emp, { fullName: e.target.value })}
                    className="border border-border rounded-md px-2 py-1.5 text-[12.5px] disabled:opacity-50"
                  />
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
                    disabled={emp.email === myEmail || !canEdit}
                    className="border border-border rounded-md px-2 py-1.5 text-[12.5px] disabled:opacity-50"
                  >
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
                          className="text-[12px] text-accent font-bold text-left"
                        >
                          Сохранить
                        </button>
                        <button
                          type="button"
                          onClick={() => discardEmployeeEdit(emp)}
                          className="text-[12px] text-muted text-left"
                        >
                          Отмена
                        </button>
                      </>
                    ) : (
                      <>
                        {emp.role !== "admin" && (
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
                          disabled={emp.email === myEmail || !canEdit}
                          onClick={() => handleDeleteEmployee(emp)}
                          className="text-[12px] text-[#A34B36] font-semibold disabled:opacity-40 text-left"
                        >
                          Удалить
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {accessEditingId === emp.id && (
                  <EmployeeAccessPanel
                    role={emp.roleId ? roles.find((r) => r.id === emp.roleId) ?? null : null}
                    cities={cities}
                    canEdit={canEdit}
                    onSave={(perms, storeAccess) => handleSaveEmployeeAccess(emp, perms, storeAccess)}
                    onCancel={() => setAccessEditingId(null)}
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
                      className="text-[12.5px] font-semibold text-paper bg-accent rounded-md px-3 py-1.5"
                    >
                      Сохранить пароль
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
              Доступ по точкам продаж настраивается после создания роли — откройте её карточку ниже.
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
                {canEdit && isCityDirty(city) ? (
                  <>
                    <button
                      type="button"
                      onClick={() => handleSaveCityEdit(city)}
                      className="text-[13px] text-accent font-bold"
                    >
                      Сохранить
                    </button>
                    <button type="button" onClick={() => discardCityEdit(city.id)} className="text-[13px] text-muted">
                      Отмена
                    </button>
                  </>
                ) : (
                  canEdit && (
                    <button type="button" onClick={() => handleDeleteCity(city)} className="text-[13px] text-[#A34B36] font-semibold">
                      Удалить город
                    </button>
                  )
                )}
              </div>

              <div className="grid grid-cols-[1fr_140px_80px] gap-3 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border pb-2">
                <div>Точка</div>
                <div>Код (store)</div>
                <div></div>
              </div>
              {city.stores.map((s) => (
                <div key={s.id} className="grid grid-cols-[1fr_140px_80px] gap-3 items-center text-[13px] py-1">
                  <input
                    type="text"
                    value={storeEdits[s.id] ?? s.name}
                    disabled={!canEdit}
                    onChange={(e) => setStoreEdits((prev) => ({ ...prev, [s.id]: e.target.value }))}
                    className="border border-border rounded-md px-2 py-1.5 text-[12.5px] disabled:opacity-50"
                  />
                  <div className="text-muted num">{s.code}</div>
                  {canEdit && isStoreDirty(s) ? (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleSaveStoreEdit(s)}
                        className="text-[12.5px] text-accent font-bold text-left"
                      >
                        Сохранить
                      </button>
                      <button type="button" onClick={() => discardStoreEdit(s.id)} className="text-[12.5px] text-muted text-left">
                        Отмена
                      </button>
                    </div>
                  ) : (
                    canEdit && (
                      <button type="button" onClick={() => handleDeleteStore(s)} className="text-[12.5px] text-[#A34B36] font-semibold text-left">
                        Удалить
                      </button>
                    )
                  )}
                </div>
              ))}

              {canEdit && (
              <div className="flex items-center gap-2 pt-2 border-t border-borderSoft">
                <input
                  type="text"
                  placeholder="Название новой точки"
                  value={newStoreName[city.id] ?? ""}
                  onChange={(e) => setNewStoreName((prev) => ({ ...prev, [city.id]: e.target.value }))}
                  className="border border-border rounded-md px-2 py-1.5 text-[12.5px] flex-1"
                />
                <input
                  type="text"
                  placeholder="код (напр. point_3)"
                  value={newStoreCode[city.id] ?? ""}
                  onChange={(e) => setNewStoreCode((prev) => ({ ...prev, [city.id]: e.target.value }))}
                  className="border border-border rounded-md px-2 py-1.5 text-[12.5px] w-[140px]"
                />
                <button
                  type="button"
                  onClick={() => handleCreateStore(city.id)}
                  className="text-[12.5px] font-semibold text-accent"
                >
                  + Добавить точку
                </button>
              </div>
              )}
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
}: {
  role: RoleDef;
  cities: CityWithStores[];
  onSave: (role: RoleDef, name: string, permissions: Permissions, storeAccess: StoreAccessGrant[]) => Promise<void>;
  onDelete: (role: RoleDef) => Promise<void>;
  canEdit: boolean;
}) {
  const [name, setName] = useState(role.name);
  const [permissions, setPermissions] = useState<Permissions>(toPermissions(role.role_permissions));
  const [storeAccess, setStoreAccess] = useState<StoreAccessGrant[]>(toGrants(role.role_store_access));
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(role, name, permissions, storeAccess);
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
              {saving ? "Сохраняем…" : "Сохранить"}
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
          <div className="text-[12px] font-semibold text-muted uppercase tracking-wide">Точки продаж</div>
          <StoreAccessEditor cities={cities} value={storeAccess} onChange={setStoreAccess} disabled={!canEdit} />
        </div>
      </div>
    </div>
  );
}
