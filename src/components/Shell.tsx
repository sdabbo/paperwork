// Navigation: a sidebar on wide screens (pages, folders, saved views), a tab bar on phones.
import React from 'react';
import { Bookmark, Building2, CalendarClock, FileSignature, Inbox, Landmark, Layers, Library, Plus, Settings, ShoppingBag, Sparkles } from 'lucide-react';
import type { CategoryInfo, SavedView, SessionInfo, ViewFilters } from '../../shared/types';
import { FixedPage, Page, isPlainClick, pagePath } from '../lib/router';
import { folderColor } from '../lib/format';
import { Button, cx } from './ui';

const PAGES: { page: FixedPage; label: string; icon: React.ReactNode }[] = [
  { page: 'library', label: 'Library', icon: <Library className="w-4 h-4" /> },
  { page: 'inbox', label: 'Inbox', icon: <Inbox className="w-4 h-4" /> },
  { page: 'deadlines', label: 'Deadlines', icon: <CalendarClock className="w-4 h-4" /> },
  { page: 'companies', label: 'Companies', icon: <Building2 className="w-4 h-4" /> },
  { page: 'topics', label: 'Topics', icon: <Layers className="w-4 h-4" /> },
  { page: 'purchases', label: 'Purchases', icon: <ShoppingBag className="w-4 h-4" /> },
  { page: 'contracts', label: 'Contracts', icon: <FileSignature className="w-4 h-4" /> },
  { page: 'taxes', label: 'Taxes', icon: <Landmark className="w-4 h-4" /> },
  { page: 'ask', label: 'Ask', icon: <Sparkles className="w-4 h-4" /> },
  { page: 'settings', label: 'Settings', icon: <Settings className="w-4 h-4" /> },
];

// Pages lit in the sidebar for another one: a company's page under Companies, a topic's under Topics
const SUBPAGES: Partial<Record<FixedPage, Page[]>> = {
  companies: ['companies', 'company'],
  topics: ['topics', 'topic'],
};

function NavLink({
  href,
  active,
  onNavigate,
  children,
  className,
}: {
  href: string;
  active: boolean;
  onNavigate: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      onClick={e => {
        if (!isPlainClick(e)) return;
        e.preventDefault();
        onNavigate();
      }}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex items-center gap-2.5 h-8 px-2.5 rounded-lg text-sm transition-colors',
        active ? 'bg-surface-3 text-ink font-medium' : 'text-ink-2 hover:text-ink hover:bg-surface-2',
        className
      )}
    >
      {children}
    </a>
  );
}

export const Sidebar: React.FC<{
  page: Page;
  navigate: (to: string) => void;
  session: SessionInfo;
  categories: CategoryInfo[];
  views: SavedView[];
  filters: ViewFilters;
  activeView: string | null;
  totalDocuments: number;
  inboxBadge: number;
  onShow: (filters: ViewFilters, viewId?: string | null) => void;
  onAdd: () => void;
}> = ({ page, navigate, session, categories, views, filters, activeView, totalDocuments, inboxBadge, onShow, onAdd }) => {
  const onlyCategory = (id: string) =>
    page === 'library' && !activeView && filters.categoryId === id && Object.keys(filters).filter(k => (filters as any)[k] !== undefined).length === 1;
  const plainLibrary = page === 'library' && !activeView && Object.values(filters).every(v => v === undefined);
  return (
    <aside className="hidden lg:flex flex-col w-64 shrink-0 h-dvh sticky top-0 border-r border-line bg-surface/60 px-3 py-5">
      <div className="flex items-center gap-2.5 px-2 mb-5">
        <img src="/icons/icon.svg" alt="" className="w-7 h-7" />
        <span className="font-semibold tracking-tight">Paperwork</span>
      </div>
      <Button variant="primary" icon={<Plus className="w-4 h-4" />} className="mx-1 mb-4" onClick={onAdd}>
        Add documents
      </Button>
      <nav className="space-y-0.5">
        {PAGES.map(p => (
          <NavLink
            key={p.page}
            href={pagePath(p.page)}
            active={p.page === 'library' ? plainLibrary : (SUBPAGES[p.page] ?? [p.page]).includes(page)}
            onNavigate={() => (p.page === 'library' ? onShow({}) : navigate(pagePath(p.page)))}
          >
            {p.icon}
            <span className="flex-1">{p.label}</span>
            {p.page === 'library' && totalDocuments > 0 && <span className="text-xs text-ink-3 tabular-nums">{totalDocuments}</span>}
            {p.page === 'inbox' && inboxBadge > 0 && (
              <span className="min-w-5 h-5 px-1.5 rounded-full bg-accent text-white dark:text-canvas text-[11px] font-semibold flex items-center justify-center tabular-nums">
                {inboxBadge}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-6 flex-1 overflow-y-auto -mx-1 px-1">
        {categories.length > 0 && (
          <>
            <div className="px-2.5 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Folders</div>
            <div className="space-y-0.5">
              {categories.map(c => (
                <NavLink key={c.id} href="/" active={onlyCategory(c.id)} onNavigate={() => onShow({ categoryId: c.id })}>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: folderColor(c.name) }} />
                  <span className="flex-1 truncate">{c.name}</span>
                  {c.count > 0 && <span className="text-xs text-ink-3 tabular-nums">{c.count}</span>}
                </NavLink>
              ))}
            </div>
          </>
        )}
        {views.length > 0 && (
          <>
            <div className="px-2.5 mt-5 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Saved views</div>
            <div className="space-y-0.5">
              {views.map(v => (
                <NavLink key={v.id} href="/" active={page === 'library' && activeView === v.id} onNavigate={() => onShow(v.filters, v.id)}>
                  <Bookmark className="w-3.5 h-3.5 text-ink-3" />
                  <span className="flex-1 truncate">{v.name}</span>
                </NavLink>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-2.5 px-2 pt-3 border-t border-line">
        {session.user?.picture ? (
          <img src={session.user.picture} alt="" className="w-7 h-7 rounded-full" referrerPolicy="no-referrer" />
        ) : (
          <div className="w-7 h-7 rounded-full bg-surface-3 flex items-center justify-center text-xs font-semibold">{session.user?.email[0]?.toUpperCase()}</div>
        )}
        <div className="min-w-0 text-xs">
          <div className="text-ink truncate">{session.user?.name}</div>
          <div className="text-ink-3 truncate">{session.user?.email}</div>
        </div>
      </div>
    </aside>
  );
};

// The phone's tab bar has room for four pages around the + button. Deadlines gets one, so it stays one tap away
// while the Library is filtered (which hides "Coming up"); Companies and Settings are buttons in the Library's
// header (Topics, Purchases, Contracts and Taxes a switch at the top of Companies), and the Library tab stays lit on
// their pages.
const tabFor = (page: FixedPage) => PAGES.find(p => p.page === page)!;

export const BottomNav: React.FC<{ page: Page; navigate: (to: string) => void; inboxBadge: number; onAdd: () => void }> = ({ page, navigate, inboxBadge, onAdd }) => {
  const isCurrent = (p: Page) => page === p || (p === 'library' && ['settings', 'companies', 'company', 'topics', 'topic', 'purchases', 'contracts', 'taxes'].includes(page));
  const item = (p: (typeof PAGES)[number]) => (
    <a
      key={p.page}
      href={pagePath(p.page)}
      onClick={e => {
        if (!isPlainClick(e)) return;
        e.preventDefault();
        navigate(pagePath(p.page));
      }}
      aria-current={page === p.page ? 'page' : undefined}
      className={cx('relative flex-1 flex flex-col items-center justify-center gap-0.5 h-14 text-[11px]', isCurrent(p.page) ? 'text-ink font-medium' : 'text-ink-3')}
    >
      {p.icon}
      {p.label}
      {p.page === 'inbox' && inboxBadge > 0 && (
        <span className="absolute top-1.5 left-1/2 ml-2 min-w-4 h-4 px-1 rounded-full bg-accent text-white dark:text-canvas text-[10px] font-semibold flex items-center justify-center">
          {inboxBadge}
        </span>
      )}
    </a>
  );
  return (
    <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t border-line bg-surface/95 backdrop-blur pb-safe">
      <div className="flex items-stretch max-w-lg mx-auto">
        {item(tabFor('library'))}
        {item(tabFor('inbox'))}
        <div className="flex-1 flex items-center justify-center">
          <button
            type="button"
            onClick={onAdd}
            aria-label="Add documents"
            className="w-11 h-11 rounded-full bg-primary text-primary-fg flex items-center justify-center shadow-md active:scale-95 transition-transform"
          >
            <Plus className="w-5 h-5" />
          </button>
        </div>
        {item(tabFor('deadlines'))}
        {item(tabFor('ask'))}
      </div>
    </nav>
  );
};
