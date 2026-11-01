// client/src/App.tsx — header + two screens: (1) the governed data foundation pipeline and
// (2) the Agent Decisions app. Desktop: tabs under the header. Phone: a bottom bar.
import { useEffect, useState } from 'react';
import { Bot, Moon, RefreshCw, Sun, Workflow, type LucideIcon } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@databricks/appkit-ui/react';
import { DatabricksLogo } from './components/DatabricksLogo';
import { DecisionsScreen } from './components/DecisionsScreen';
import { GeniePanel } from './components/GeniePanel';
import { PipelineScreen } from './components/PipelineScreen';
import { getJson, postJson, useJson, type UiConfig } from './lib/api';
import { useTheme } from './lib/theme';

type Tab = 'pipeline' | 'decisions';
const TABS: { id: Tab; label: string; short: string; icon: LucideIcon }[] = [
  { id: 'pipeline', label: '1 · Data foundation pipeline', short: 'Pipeline', icon: Workflow },
  { id: 'decisions', label: '2 · Agent Decisions', short: 'Decisions', icon: Bot },
];

export default function App() {
  const config = useJson<UiConfig>('/api/config');
  const [me, setMe] = useState<{ email: string | null } | null>(null);
  const [tab, setTab] = useState<Tab>('pipeline');
  const [epoch, setEpoch] = useState(0);
  const [visits, setVisits] = useState(0);
  const [resetError, setResetError] = useState<string | null>(null);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    getJson<{ email: string | null }>('/api/whoami')
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  function go(t: Tab) {
    if (t === 'decisions') setVisits((v) => v + 1);
    setTab(t);
    window.scrollTo({ top: 0 });
  }

  function reset() {
    if (!window.confirm('Reset the app? This re-seeds the sources and clears all runs and decisions.')) return;
    setResetError(null);
    postJson('/api/reset', {})
      .then(() => {
        setEpoch((e) => e + 1);
        go('pipeline');
      })
      .catch((e: unknown) => setResetError(e instanceof Error ? e.message : String(e)));
  }

  if (config.loading) return <Skeleton className="m-4 h-96 md:m-6" />;
  if (config.error || !config.data) {
    return (
      <Alert variant="destructive" className="m-4 md:m-6">
        <AlertDescription>{config.error ?? 'No config'}</AlertDescription>
      </Alert>
    );
  }
  const c = config.data;

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b bg-card px-4 py-3 md:px-6">
        <div className="flex items-center gap-3 md:gap-4">
          <DatabricksLogo className="h-5 w-auto shrink-0 md:h-6" />
          <span aria-hidden className="h-8 w-px shrink-0 bg-border" />
          <div className="min-w-0 flex-1">
            <h1 className="m-0 truncate text-base font-semibold leading-tight md:text-lg">{c.title}</h1>
            <p className="m-0 truncate text-xs text-muted-foreground md:text-sm">
              For {c.persona}
              <span className="hidden sm:inline"> · {c.subtitle}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1 md:gap-2">
            <Badge variant="secondary" className="hidden max-w-56 truncate md:inline-flex">
              {me?.email ?? 'Signed in'}
            </Badge>
            <GeniePanel enabled={c.genie_enabled} spaceUrl={c.genie_space_url} />
            {c.reset_enabled && (
              <Button
                size="icon"
                variant="ghost"
                className="size-11 md:size-8"
                aria-label="Reset"
                title="Reset"
                onClick={reset}
              >
                <RefreshCw aria-hidden className="size-4" />
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="size-11 md:size-8"
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={toggleTheme}
            >
              {theme === 'dark' ? <Moon aria-hidden className="size-4" /> : <Sun aria-hidden className="size-4" />}
            </Button>
          </div>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => go(v as Tab)}>
        <div className="hidden border-b bg-card px-6 pb-3 md:block">
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id} className="gap-1.5 data-[state=active]:[&>svg]:text-brand">
                <t.icon aria-hidden className="size-4" />
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <main className="px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-4 md:px-6 md:pb-10 md:pt-6">
          {resetError && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{resetError}</AlertDescription>
            </Alert>
          )}
          {/* forceMount keeps a running pipeline animation alive while the presenter looks at Screen 2. */}
          <TabsContent value="pipeline" forceMount className="mt-0 data-[state=inactive]:hidden">
            <PipelineScreen key={epoch} config={c} onOpenDecisions={() => go('decisions')} />
          </TabsContent>
          <TabsContent value="decisions" forceMount className="mt-0 data-[state=inactive]:hidden">
            <DecisionsScreen key={epoch} visits={visits} onOpenPipeline={() => go('pipeline')} />
          </TabsContent>
        </main>
      </Tabs>

      <nav
        aria-label="Screens"
        className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-2 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => go(t.id)}
              className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring ${
                active ? 'text-foreground' : 'text-muted-foreground'
              }`}
            >
              {active && <span aria-hidden className="absolute inset-x-8 top-0 h-0.5 rounded-full bg-brand" />}
              <t.icon aria-hidden className={`size-5 ${active ? 'text-brand' : ''}`} />
              {t.short}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
