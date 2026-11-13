import { useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  CalendarDays,
  ChevronDown,
  Inbox,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Smartphone,
  Sun,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  isOpenTask,
  listColorSlug,
  listDisplayName,
  taskDayKey,
  todayKeyInZone,
  userDisplayName,
} from "@/lib/format";
import { useAppData } from "@/lib/queries";
import { endSession } from "@/lib/session";
import { cn, initials } from "@/lib/utils";
import { BrandMark } from "./BrandMark";
import { Hint } from "./Hint";
import { NewListDialog } from "./NewListDialog";

type NavPath =
  | "/today"
  | "/upcoming"
  | "/inbox"
  | "/calendar"
  | "/lists"
  | "/settings"
  | "/trash";

function SidebarNavItem({
  to,
  label,
  icon,
  count,
  active,
  collapsed,
}: {
  to: NavPath;
  label: string;
  icon: ReactNode;
  count?: number;
  active: boolean;
  collapsed: boolean;
}) {
  const link = (
    <Link
      to={to}
      className={cn("nav-item", collapsed && "justify-center px-0")}
      aria-current={active ? "page" : undefined}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">
        {icon}
      </span>
      {collapsed ? (
        <span className="sr-only">
          {label}
          {typeof count === "number" && count > 0 ? `, ${count}` : ""}
        </span>
      ) : (
        <>
          <span className="truncate">{label}</span>
          {typeof count === "number" && count > 0 ? (
            <span className="ml-auto text-12 tabular-nums text-faint">{count}</span>
          ) : null}
        </>
      )}
    </Link>
  );

  if (!collapsed) return link;
  return (
    <Hint
      label={`${label}${typeof count === "number" && count > 0 ? ` · ${count}` : ""}`}
      side="right"
    >
      {link}
    </Hint>
  );
}

export function Sidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const { tasks, lists, tags, user } = useAppData();
  const [newListOpen, setNewListOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const openTasks = tasks.filter(isOpenTask);
  // Count in the account timezone, matching the server's view=today/upcoming.
  const zone = user?.timezone ?? undefined;
  const today = todayKeyInZone(zone);
  const todayCount = openTasks.filter((task) => {
    const key = taskDayKey(task, zone);
    return Boolean(key && key <= today);
  }).length;
  const upcomingCount = openTasks.filter((task) => {
    const key = taskDayKey(task, zone);
    return Boolean(key && key > today);
  }).length;
  const inboxCount = openTasks.filter((task) => !taskDayKey(task, zone)).length;
  const listCounts = new Map<string, number>();
  for (const task of openTasks) {
    if (task.listId) listCounts.set(task.listId, (listCounts.get(task.listId) ?? 0) + 1);
  }

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await endSession();
      toast.success("Signed out.");
      void navigate({ to: "/login", replace: true });
    } finally {
      setSigningOut(false);
    }
  };

  const name = userDisplayName(user);

  return (
    <>
      <aside
        id="primary-sidebar"
        className={cn(
          "hidden shrink-0 flex-col border-r border-hairline bg-surface transition-[width] duration-200 md:flex",
          collapsed ? "w-[76px]" : "w-[252px]",
        )}
        aria-label="Primary"
      >
        <div
          className={cn(
            "flex items-center border-b border-hairline",
            collapsed ? "flex-col gap-1 px-3 py-2" : "h-14 gap-2 px-3",
          )}
        >
          <Link
            to="/today"
            className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md"
            aria-label="Morrow — Today"
          >
            <BrandMark />
            {!collapsed ? (
              <span className="serif text-22 leading-none">Morrow</span>
            ) : null}
          </Link>
          <button
            type="button"
            className={cn("icon-btn", !collapsed && "ml-auto")}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            aria-controls="primary-sidebar"
            onClick={onToggle}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-[18px] w-[18px]" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="h-[18px] w-[18px]" aria-hidden="true" />
            )}
          </button>
        </div>

        <nav
          className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-3"
          aria-label="Main navigation"
        >
          <div className="space-y-0.5">
            <SidebarNavItem
              to="/today"
              label="Today"
              icon={<Sun className="h-[18px] w-[18px]" />}
              count={todayCount}
              active={pathname === "/today"}
              collapsed={collapsed}
            />
            <SidebarNavItem
              to="/upcoming"
              label="Upcoming"
              icon={<CalendarDays className="h-[18px] w-[18px]" />}
              count={upcomingCount}
              active={pathname === "/upcoming"}
              collapsed={collapsed}
            />
            <SidebarNavItem
              to="/inbox"
              label="Inbox"
              icon={<Inbox className="h-[18px] w-[18px]" />}
              count={inboxCount}
              active={pathname === "/inbox"}
              collapsed={collapsed}
            />
            <SidebarNavItem
              to="/calendar"
              label="Calendar"
              icon={<CalendarDays className="h-[18px] w-[18px]" />}
              active={pathname === "/calendar"}
              collapsed={collapsed}
            />
          </div>

          <div className="my-3 h-px bg-hairline" />

          {collapsed ? (
            <div className="flex justify-center">
              <Hint label="New list" side="right">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="New list"
                  onClick={() => setNewListOpen(true)}
                >
                  <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
                </button>
              </Hint>
            </div>
          ) : (
            <div className="mb-1 flex items-center justify-between px-2">
              <span className="label-caps">Lists</span>
              <button
                type="button"
                className="icon-btn -mr-2"
                aria-label="New list"
                onClick={() => setNewListOpen(true)}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          )}

          <div className="space-y-0.5">
            {lists.map((list) => {
              const active = pathname === `/lists/${list.id}`;
              const label = (
                <Link
                  key={list.id}
                  to="/lists/$listId"
                  params={{ listId: list.id }}
                  data-list-color={listColorSlug(list.color)}
                  className={cn("nav-item", collapsed && "justify-center px-0")}
                  aria-current={active ? "page" : undefined}
                  aria-label={collapsed ? listDisplayName(list) : undefined}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                    <span className="list-dot" aria-hidden="true" />
                  </span>
                  {collapsed ? (
                    <span className="sr-only">{listDisplayName(list)}</span>
                  ) : (
                    <>
                      <span className="truncate">{listDisplayName(list)}</span>
                      {listCounts.get(list.id) ? (
                        <span className="ml-auto text-12 tabular-nums text-faint">
                          {listCounts.get(list.id)}
                        </span>
                      ) : null}
                    </>
                  )}
                </Link>
              );
              return collapsed ? (
                <Hint key={list.id} label={listDisplayName(list)} side="right">
                  {label}
                </Hint>
              ) : (
                label
              );
            })}
            {!collapsed && lists.length === 0 ? (
              <p className="px-2 py-2 text-12 leading-relaxed text-faint">
                No lists yet. A list is optional.
              </p>
            ) : null}
          </div>

          {tags.length > 0 ? (
            <>
              <div className="my-3 h-px bg-hairline" />
              {!collapsed ? (
                <div className="mb-1 px-2">
                  <span className="label-caps">Tags</span>
                </div>
              ) : null}
              <div className="space-y-0.5">
                {tags.slice(0, 12).map((tag) => {
                  const active = pathname === `/tags/${tag.id}`;
                  const label = (
                    <Link
                      to="/tags/$tagId"
                      params={{ tagId: tag.id }}
                      className={cn("nav-item", collapsed && "justify-center px-0")}
                      aria-current={active ? "page" : undefined}
                      aria-label={collapsed ? tag.name : undefined}
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                        <span className="h-2 w-2 rounded-full bg-current opacity-60" aria-hidden="true" />
                      </span>
                      {collapsed ? (
                        <span className="sr-only">{tag.name}</span>
                      ) : (
                        <>
                          <span className="truncate">{tag.name}</span>
                          {tag.openCount ? (
                            <span className="ml-auto text-12 tabular-nums text-faint">
                              {tag.openCount}
                            </span>
                          ) : null}
                        </>
                      )}
                    </Link>
                  );
                  return collapsed ? (
                    <Hint key={tag.id} label={tag.name} side="right">
                      {label}
                    </Hint>
                  ) : (
                    label
                  );
                })}
              </div>
            </>
          ) : null}
        </nav>

        <div className="border-t border-hairline p-2">
          <SidebarNavItem
            to="/trash"
            label="Recently deleted"
            icon={<Trash2 className="h-[18px] w-[18px]" />}
            active={pathname === "/trash"}
            collapsed={collapsed}
          />
          <SidebarNavItem
            to="/settings"
            label="Settings"
            icon={<Settings className="h-[18px] w-[18px]" />}
            active={
              pathname.startsWith("/settings") || pathname === "/install"
            }
            collapsed={collapsed}
          />

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className={cn(
                  "mt-1 flex min-h-11 w-full items-center gap-2 rounded-md p-1 text-left hover:bg-selection",
                  collapsed && "justify-center",
                )}
                aria-label="Account menu"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-hairline bg-accent-soft text-12 font-semibold text-accent">
                  {initials(name)}
                </span>
                {!collapsed ? (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-13 font-medium text-ink">
                        {name}
                      </span>
                      <span className="block truncate text-12 text-muted">
                        {user?.email || "Local account"}
                      </span>
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
                  </>
                ) : null}
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="top"
                align="start"
                sideOffset={6}
                className="z-[60] min-w-52 rounded-md border border-hairline bg-canvas p-1 text-13 shadow-lg"
              >
                <div className="px-2.5 py-2">
                  <p className="truncate font-medium text-ink">{name}</p>
                  <p className="truncate text-12 text-muted">
                    {user?.email || "Local account"}
                  </p>
                </div>
                <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
                <DropdownMenu.Item
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2.5 outline-none data-[highlighted]:bg-selection"
                  onSelect={() => void navigate({ to: "/settings" })}
                >
                  <Settings className="h-4 w-4 text-muted" aria-hidden="true" />
                  Settings
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2.5 outline-none data-[highlighted]:bg-selection"
                  onSelect={() => void navigate({ to: "/install" })}
                >
                  <Smartphone className="h-4 w-4 text-muted" aria-hidden="true" />
                  Install Morrow
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
                <DropdownMenu.Item
                  disabled={signingOut}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2.5 text-danger outline-none data-[highlighted]:bg-danger-soft"
                  onSelect={() => void signOut()}
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                  {signingOut ? "Signing out…" : "Sign out"}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </aside>

      <NewListDialog open={newListOpen} onOpenChange={setNewListOpen} />
    </>
  );
}
