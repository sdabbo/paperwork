// Before the app: signing in, then connecting Google Drive (once, by the owner).
import React, { useState } from 'react';
import { FolderOpen, Mail, ScanLine, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import type { SessionInfo } from '../../shared/types';
import { signOut } from '../lib/api';
import { Card, LinkButton, Notice } from './ui';

const Logo: React.FC<{ className?: string }> = ({ className }) => <img src="/icons/icon.svg" alt="" className={className ?? 'w-10 h-10'} />;

const Frame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="min-h-dvh flex items-center justify-center px-4 py-10">
    <div className="w-full max-w-md">{children}</div>
  </div>
);

const Point: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode }> = ({ icon, title, children }) => (
  <li className="flex gap-3">
    <div className="w-8 h-8 shrink-0 rounded-lg bg-accent-soft text-accent-ink flex items-center justify-center">{icon}</div>
    <div>
      <div className="text-sm font-medium text-ink">{title}</div>
      <div className="text-sm text-ink-2">{children}</div>
    </div>
  </li>
);

// Signing in comes back to the page the address pointed at (e.g. a document an AI assistant linked to), without
// the sign-in error the server may have added to it
function signInHref(): string {
  const url = new URL(window.location.href);
  if (url.searchParams.has('error')) url.searchParams.delete('error');
  const next = url.pathname + url.search;
  return next === '/' || next.startsWith('//') ? '/auth/signin' : `/auth/signin?next=${encodeURIComponent(next)}`;
}

export const SignInScreen: React.FC<{ error: string | null }> = ({ error }) => (
  <Frame>
    <div className="flex items-center gap-3 mb-8">
      <Logo />
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Paperwork</h1>
        <p className="text-sm text-ink-2">Your documents, filed in your own Google Drive</p>
      </div>
    </div>
    {error && (
      <Notice tone="danger" icon={<TriangleAlert className="w-4 h-4" />} className="mb-4">
        {error}
      </Notice>
    )}
    <Card className="p-5">
      <ul className="space-y-4 mb-6">
        <Point icon={<ScanLine className="w-4 h-4" />} title="Scan, upload or forward">
          Snap a letter, drop in a PDF, or forward an email with an invoice.
        </Point>
        <Point icon={<Sparkles className="w-4 h-4" />} title="Filed for you">
          Paperwork reads each document, names it, sums it up and puts it in the right folder.
        </Point>
        <Point icon={<FolderOpen className="w-4 h-4" />} title="Yours, in Google Drive">
          Everything stays in one folder in your Drive, neatly organized even without this app.
        </Point>
      </ul>
      <LinkButton href={signInHref()} variant="primary" className="w-full h-10">
        Sign in with Google
      </LinkButton>
    </Card>
  </Frame>
);

export const ConnectScreen: React.FC<{ session: SessionInfo; error: string | null }> = ({ session, error }) => {
  const vault = session.vault;
  const owner = vault?.ownerEmail;
  const someoneElse = owner && owner !== session.user?.email && !vault?.problem;
  // Why signing out didn't work, when it didn't
  const [signOutError, setSignOutError] = useState<string | null>(null);
  return (
    <Frame>
      <div className="flex items-center gap-3 mb-8">
        <Logo />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Connect Google Drive</h1>
          <p className="text-sm text-ink-2">Signed in as {session.user?.email}</p>
        </div>
      </div>
      {error && (
        <Notice tone="danger" icon={<TriangleAlert className="w-4 h-4" />} className="mb-4">
          {error}
        </Notice>
      )}
      <Card className="p-5">
        <p className="text-sm text-ink-2 mb-4">
          Paperwork keeps your documents in a folder called <b className="text-ink">{vault?.rootName ?? 'Paperwork'}</b> in your Google Drive. It creates
          the folder when you connect, with an <b className="text-ink">Inbox</b> and a folder per category.
        </p>
        <ul className="space-y-4 mb-6">
          <Point icon={<ShieldCheck className="w-4 h-4" />} title="Creates and organizes, never deletes">
            Paperwork adds files and folders, renames and moves them inside its folder, and writes a summary into each file's details. It never deletes,
            trashes, shares or overwrites anything, and leaves the rest of your Drive alone.
          </Point>
          <Point icon={<ScanLine className="w-4 h-4" />} title={vault?.access === 'app' ? 'Only its own files' : 'Scan straight into Drive'}>
            {vault?.access === 'app'
              ? "Google lets Paperwork see only the files it created and the ones you pick from your Drive, such as scans made with the Drive app. The rest of your Drive stays out of its reach."
              : "Scans you save into the Inbox with the Google Drive app are filed within minutes, so Google asks to let Paperwork see your Drive's files."}
          </Point>
          <Point icon={<Mail className="w-4 h-4" />} title="Works while the app is closed">
            Google asks for lasting access so emailed documents and new scans are filed without you opening Paperwork.
          </Point>
        </ul>
        {someoneElse ? (
          <Notice tone="warning">Drive is connected through {owner}. Ask them to open Paperwork, or to disconnect it in Settings first.</Notice>
        ) : (
          <LinkButton href="/auth/connect" variant="primary" className="w-full h-10">
            Connect Google Drive
          </LinkButton>
        )}
        <form
          className="mt-3 text-center"
          onSubmit={async e => {
            e.preventDefault();
            setSignOutError(null);
            const problem = await signOut();
            if (problem) setSignOutError(problem);
            else window.location.href = '/';
          }}
        >
          <button className="text-sm text-ink-2 hover:text-ink">Use another account</button>
          {signOutError && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {signOutError}
            </p>
          )}
        </form>
      </Card>
    </Frame>
  );
};
