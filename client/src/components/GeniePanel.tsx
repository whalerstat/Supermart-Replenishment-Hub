// client/src/components/GeniePanel.tsx — "Ask Genie": a header button that opens a right-hand sheet with an
// AI/BI Genie chat over the Lakebase tables. The chat state lives above the sheet so a closed panel keeps
// its conversation. Esc closes and focus returns to the button (Radix dialog behaviour).
import type { ReactNode } from 'react';
import { ExternalLink, Sparkles } from 'lucide-react';
import {
  Button,
  GenieChatInput,
  GenieChatMessageList,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  useGenieChat,
} from '@databricks/appkit-ui/react';

const SAMPLE_QUESTIONS = [
  'Which stores have the most flagged stock-out signals?',
  'Compare the 7-day forecast with on-hand stock for the lowest days of cover',
  'How many recommendations were approved, rejected or are still proposed?',
  'Which outbox messages were queued, and to whom?',
];

function Shell({ spaceUrl, children }: { spaceUrl: string | null; children: ReactNode }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="min-h-11 gap-1.5 md:min-h-8">
          <Sparkles aria-hidden className="size-4 text-brand" />
          Ask Genie
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-lg">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Ask Genie</SheetTitle>
          <SheetDescription>
            Ask questions about the mock data in Lakebase. Genie writes the SQL; check it before trusting a number.
          </SheetDescription>
          {spaceUrl && (
            <a
              href={spaceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-fit items-center gap-1 text-sm underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
            >
              Open in Genie
              <ExternalLink aria-hidden className="size-3.5" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}

function GenieEnabled({ spaceUrl }: { spaceUrl: string | null }) {
  const { messages, status, error, sendMessage, reset, hasPreviousPage, fetchPreviousPage } = useGenieChat({
    alias: 'default',
  });
  const busy = status === 'streaming' || status === 'loading-history';

  return (
    <Shell spaceUrl={spaceUrl}>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        {SAMPLE_QUESTIONS.map((q) => (
          <Button
            key={q}
            variant="outline"
            size="sm"
            className="h-auto min-h-11 whitespace-normal py-1.5 text-left md:min-h-8"
            disabled={busy}
            onClick={() => sendMessage(q)}
          >
            {q}
          </Button>
        ))}
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" className="min-h-11 md:min-h-8" onClick={reset}>
            New conversation
          </Button>
        )}
      </div>
      <GenieChatMessageList
        messages={messages}
        status={status}
        hasPreviousPage={hasPreviousPage}
        onFetchPreviousPage={fetchPreviousPage}
      />
      {error && (
        <div role="alert" className="shrink-0 border-t bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <GenieChatInput onSend={sendMessage} disabled={busy} placeholder="Ask about stores, stock, forecasts…" />
    </Shell>
  );
}

function GenieDisabled() {
  return (
    <Shell spaceUrl={null}>
      <p className="m-0 p-4 text-sm text-muted-foreground">
        Genie is not configured for this deployment. Create the space with <code>scripts/build-genie-space.mjs</code>{' '}
        and set <code>DATABRICKS_GENIE_SPACE_ID</code> to enable it.
      </p>
    </Shell>
  );
}

export function GeniePanel({ enabled, spaceUrl }: { enabled: boolean; spaceUrl: string | null }) {
  return enabled ? <GenieEnabled spaceUrl={spaceUrl} /> : <GenieDisabled />;
}
