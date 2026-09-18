"use client";

import { Fragment, useEffect, useState } from "react";
import { authFetch } from "@/lib/apiClient";
import { SECTIONS, emptyPermissions, type Permissions } from "@/lib/permissions";
import { useAuth } from "@/components/AuthGate";

type Employee = {
  id: string;
  email: string;
  role: "admin" | "editor" | null;
  roleId: number | null;
};

type RoleDef = {
  id: number;
  name: string;
  role_permissions: { section: string; can_view: boolean; can_edit: boolean }[];
};

function toPermissions(rows: RoleDef["role_permissions"]): Permissions {
  const p = emptyPermissions();
  for (const row of rows) {
    if (row.section in p) {
      p[row.section as keyof Permissions] = { canView: row.can_view, canEdit: row.can_edit };
    }
  }
  return p;
}

function PermissionsGrid({
  value,
  onChange,
}: {
  value: Permissions;
  onChange: (next: Permissions) => void;
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
              onChange={(e) =>
                onChange({
                  ...value,
                  [s.key]: {
                    canView: e.target.checked,
                    canEdit: e.target.checked ? value[s.key].canEdit : false,
                  },
                })
              }
              className="accent-accent"
            />
          </div>
          <div className="py-1.5 border-t border-borderSoft text-center">
            <input
              type="checkbox"
              checked={value[s.key].canEdit}
              disabled={!value[s.key].canView}
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

export default function EmployeesPage() {
  const { email: myEmail } = useAuth();
  const [tab, setTab] = useState<"employees" | "roles">("employees");

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRoleChoice, setNewRoleChoice] = useState("admin"); // "admin" | "" | "<roleId>"
  const [creating, setCreating] = useState(false);

  const [newRoleName, setNewRoleName] = useState("");
  const [newRolePerms, setNewRolePerms] = useState<Permissions>(emptyPermissions());
  const [creatingRole, setCreatingRole] = useState(false);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [employeesRes, rolesRes] = await Promise.all([
        authFetch("/api/employees"),
        authFetch("/api/roles"),
      ]);
      setEmployees(employeesRes.employees);
      setRoles(rolesRes.roles);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось изменить роль.");
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
          role: newRoleChoice === "admin" ? "admin" : "custom",
          roleId: newRoleChoice === "admin" || newRoleChoice === "" ? null : Number(newRoleChoice),
        }),
      });
      setEmployees((prev) => [
        ...prev,
        {
          id: created.id,
          email: created.email,
          role: newRoleChoice === "admin" ? "admin" : "editor",
          roleId: newRoleChoice === "admin" || newRoleChoice === "" ? null : Number(newRoleChoice),
        },
      ]);
      setNewEmail("");
      setNewPassword("");
      setNewRoleChoice("admin");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось создать сотрудника.");
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveRole(role: RoleDef, name: string, permissions: Permissions) {
    setError(null);
    try {
      await authFetch(`/api/roles/${role.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, permissions }),
      });
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

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Настройки</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">Сотрудники и доступы</h1>
        <p className="text-sm text-muted max-w-xl mt-1">
          Создавайте сотрудников и роли с гибким доступом: для каждого раздела портала можно
          отдельно разрешить просмотр и редактирование.
        </p>
        {error && <p className="text-sm text-[#A34B36]">{error}</p>}
      </div>

      <div className="flex items-center gap-1.5 bg-white border border-border rounded-card p-1.5 w-fit">
        {(["employees", "roles"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`text-[13px] rounded-md px-3.5 py-2 ${
              tab === t ? "bg-accent text-paper font-bold" : "text-muted font-medium"
            }`}
          >
            {t === "employees" ? "Сотрудники" : "Роли доступа"}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-sm text-muted">Загрузка…</div>
      ) : tab === "employees" ? (
        <div className="flex flex-col gap-4">
          <div className="bg-white border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            <div className="text-[15px] font-bold">Список сотрудников</div>
            <div className="grid grid-cols-[1fr_200px_100px] gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
              <div>Email</div>
              <div>Роль</div>
              <div></div>
            </div>
            {employees.map((emp) => (
              <div
                key={emp.id}
                className="grid grid-cols-[1fr_200px_100px] gap-3 py-2.5 border-b border-borderSoft items-center text-[13px]"
              >
                <div>
                  {emp.email} {emp.email === myEmail && <span className="text-muted">(вы)</span>}
                </div>
                <select
                  value={roleChoiceValue(emp)}
                  onChange={(e) => handleRoleChange(emp, e.target.value)}
                  disabled={emp.email === myEmail}
                  className="border border-border rounded-md px-2 py-1.5 text-[12.5px] disabled:opacity-50"
                >
                  <option value="admin">Администратор</option>
                  <option value="">Без роли</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={emp.email === myEmail}
                  onClick={() => handleDeleteEmployee(emp)}
                  className="text-[12.5px] text-[#A34B36] font-semibold disabled:opacity-40 text-left"
                >
                  Удалить
                </button>
              </div>
            ))}
          </div>

          <form
            onSubmit={handleCreateEmployee}
            className="bg-white border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5"
          >
            <div className="text-[15px] font-bold">Добавить сотрудника</div>
            <div className="grid grid-cols-3 gap-3">
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
                {roles.map((r) => (
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
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {roles.map((role) => (
            <RoleCard key={role.id} role={role} onSave={handleSaveRole} onDelete={handleDeleteRole} />
          ))}

          <form
            onSubmit={handleCreateRole}
            className="bg-white border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5"
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
            <button
              type="submit"
              disabled={creatingRole}
              className="self-start text-[13px] font-bold text-paper bg-accent rounded-lg px-[18px] py-2.5 disabled:opacity-50"
            >
              {creatingRole ? "Создаём…" : "Создать роль"}
            </button>
          </form>
        </div>
      )}
    </>
  );
}

function RoleCard({
  role,
  onSave,
  onDelete,
}: {
  role: RoleDef;
  onSave: (role: RoleDef, name: string, permissions: Permissions) => Promise<void>;
  onDelete: (role: RoleDef) => Promise<void>;
}) {
  const [name, setName] = useState(role.name);
  const [permissions, setPermissions] = useState<Permissions>(toPermissions(role.role_permissions));
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(role, name, permissions);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-white border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="border border-border rounded-lg px-3 py-2 text-sm font-bold flex-1 max-w-sm"
        />
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
      </div>
      <PermissionsGrid value={permissions} onChange={setPermissions} />
    </div>
  );
}
