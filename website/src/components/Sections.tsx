import {
  BookOpen,
  Check,
  Clapperboard,
  FileInput,
  FilePenLine,
  FileText,
  HardDrive,
  Headphones,
  KeyRound,
  Languages,
  LayoutPanelLeft,
  ListChecks,
  ListTodo,
  Plus,
  Plug,
  Mic,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Undo2,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { ToolKey } from '../content'
import { useSite } from '../context'
import { Shot } from './Shot'
import { Container, Reveal, SectionHeading, cx } from './ui'

const PILLAR_ICONS: LucideIcon[] = [LayoutPanelLeft, HardDrive, Undo2, KeyRound]
const STUDIO_ICONS: LucideIcon[] = [FileInput, Mic, Sparkles, Headphones, ListChecks]
const AGENT_ICONS: LucideIcon[] = [Wrench, ListTodo, BookOpen]
const TOOL_ICONS: Record<ToolKey, LucideIcon> = {
  translate: Languages,
  convert: RefreshCw,
  extract: FileText,
  transcribe: Clapperboard,
  rename: FilePenLine,
  longText: BookOpen,
}

export function Pillars() {
  const { t } = useSite()
  return (
    <section aria-label="FusionKit" className="border-y bg-surface">
      <Container>
        <ul className="grid divide-y sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
          {t.pillars.map((pillar, index) => {
            const Icon = PILLAR_ICONS[index]
            return (
              <li
                key={pillar.title}
                className={cx(
                  'py-8 sm:px-6 lg:py-10',
                  // Two columns on tablets: the left column keeps the page gutter.
                  index % 2 === 0 ? 'sm:pl-0' : 'sm:border-l',
                  index < 2 && 'sm:border-b lg:border-b-0',
                  index === 0 && 'lg:pl-0',
                  index === 2 && 'lg:pl-6',
                  index === 3 && 'lg:pr-0',
                )}
              >
                <Icon className="size-5 text-foreground" strokeWidth={1.75} aria-hidden="true" />
                <h3 className="mt-4 font-semibold">{pillar.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{pillar.body}</p>
              </li>
            )
          })}
        </ul>
      </Container>
    </section>
  )
}

export function Studio() {
  const { t } = useSite()
  return (
    <section id="features" className="py-24 sm:py-32" aria-labelledby="studio-title">
      <Container>
        <Reveal>
          <SectionHeading id="studio-title" tone="studio" kicker={t.studio.kicker} title={t.studio.title} body={t.studio.body} />
        </Reveal>
        {/* One reveal for the whole grid: the 1px gaps are the grid's own background,
            so fading cells in one by one would flash it as a solid block. */}
        <Reveal className="mt-14 grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2 lg:grid-cols-6">
          {t.studio.items.map((item, index) => {
            const Icon = STUDIO_ICONS[index]
            return (
              <div
                key={item.title}
                className={cx(
                  'bg-card p-6 sm:p-7',
                  index < 3 ? 'lg:col-span-2' : 'lg:col-span-3',
                  index === 4 && 'sm:col-span-2 lg:col-span-3',
                )}
              >
                <span className="inline-flex size-9 items-center justify-center rounded-lg bg-studio-soft text-studio">
                  <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
                </span>
                <h3 className="mt-5 font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.body}</p>
              </div>
            )
          })}
        </Reveal>
      </Container>
    </section>
  )
}

export function Agent() {
  const { t } = useSite()
  const { agent } = t
  return (
    <section id="agent" className="border-t bg-surface py-24 sm:py-32" aria-labelledby="agent-title">
      <Container>
        <div className="grid items-center gap-12 lg:grid-cols-12 lg:gap-16">
          <Reveal className="lg:col-span-5">
            <SectionHeading id="agent-title" kicker={agent.kicker} title={agent.title} body={agent.body} />
            <ul className="mt-10 space-y-6">
              {agent.items.map((item, index) => {
                const Icon = AGENT_ICONS[index]
                return (
                  <li key={item.title} className="flex gap-4">
                    <Icon className="mt-0.5 size-5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                    <div>
                      <h3 className="font-semibold">{item.title}</h3>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.body}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
          </Reveal>
          <Reveal className="lg:col-span-7" delay={0.08}>
            <Shot
              name="agent"
              alt={agent.shotAlt}
              crop={[0.2, 0.8]}
              sizes="(min-width: 1024px) 1100px, 170vw"
            />
          </Reveal>
        </div>

        <Reveal className="mt-16">
          <h3 className="text-sm font-semibold text-muted-foreground">{agent.modesTitle}</h3>
          <ol className="mt-4 grid gap-3 sm:grid-cols-3">
            {agent.modes.map((mode, index) => (
              <li key={mode.title} className="flex items-baseline gap-3 rounded-xl border bg-card px-5 py-4">
                <span className="font-mono text-xs text-muted-foreground tabular-nums">0{index + 1}</span>
                <div className="min-w-0">
                  <p className="font-medium">{mode.title}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{mode.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </Reveal>

        <div className="mt-24 grid items-center gap-12 lg:grid-cols-12 lg:gap-16">
          <Reveal className="lg:order-2 lg:col-span-5">
            <h3 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{agent.dockTitle}</h3>
            <p className="mt-4 leading-7 text-pretty text-muted-foreground">{agent.dockBody}</p>
          </Reveal>
          <Reveal className="lg:order-1 lg:col-span-7" delay={0.08}>
            <Shot name="dock" alt={agent.dockAlt} crop={[0, 0.62]} sizes="(min-width: 1024px) 1100px, 160vw" />
          </Reveal>
        </div>

        <ExternalAgents />
      </Container>
    </section>
  )
}

function ExternalAgents() {
  const { t } = useSite()
  const { external } = t.agent
  const { demo } = external
  return (
    <div id="external-agents" className="mt-24 grid scroll-mt-24 items-center gap-12 lg:grid-cols-12 lg:gap-16">
      <Reveal className="lg:col-span-5">
        <p className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <Plug className="size-4" strokeWidth={1.75} aria-hidden="true" />
          {external.label}
        </p>
        <h3 className="mt-3 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{external.title}</h3>
        <p className="mt-4 leading-7 text-pretty text-muted-foreground">{external.body}</p>
        <ol className="mt-8 space-y-5">
          {external.steps.map((step, index) => (
            <li key={step.title} className="flex gap-4">
              <span className="font-mono text-xs leading-6 text-muted-foreground tabular-nums">0{index + 1}</span>
              <div className="min-w-0">
                <h4 className="font-semibold">{step.title}</h4>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-8 text-sm font-medium">{external.clientsLabel}</p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {external.clients.map((client) => (
            <li key={client} className="rounded-full border bg-card px-3 py-1 text-sm">
              {client}
            </li>
          ))}
        </ul>
        <p className="mt-6 flex gap-2 text-sm leading-6 text-muted-foreground">
          <ShieldCheck className="mt-1 size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span>{external.note}</span>
        </p>
      </Reveal>

      <Reveal className="lg:col-span-7" delay={0.08}>
        <figure className="shot overflow-hidden rounded-2xl border bg-card" aria-label={demo.label}>
          <div className="flex items-center gap-3 border-b px-5 py-3.5">
            <SquareTerminal className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
            <p className="text-sm font-medium">{demo.client}</p>
            <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              fusionkit
            </span>
          </div>
          <div className="space-y-5 p-5 sm:p-6">
            <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm leading-6">
              {demo.prompt}
            </p>
            <ol className="overflow-hidden rounded-xl border">
              {demo.calls.map((call) => (
                <li
                  key={call.tool}
                  className="flex flex-col gap-1 border-b px-4 py-2.5 last:border-b-0 sm:flex-row sm:items-center sm:gap-3"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Check className="size-3.5 shrink-0 text-studio" strokeWidth={2.25} aria-hidden="true" />
                    <code className="font-mono text-xs break-all">{call.tool}</code>
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-2 pl-5.5 text-xs text-muted-foreground sm:ml-auto sm:justify-end sm:pl-0">
                    {call.confirmed && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-studio-soft px-2 py-0.5 font-medium text-studio">
                        <ShieldCheck className="size-3" strokeWidth={2} aria-hidden="true" />
                        {demo.confirmed}
                      </span>
                    )}
                    <span>{call.result}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="text-sm leading-6">{demo.reply}</p>
          </div>
        </figure>
      </Reveal>
    </div>
  )
}

export function Knowledge() {
  const { t } = useSite()
  const { knowledge } = t
  const { table } = knowledge
  const levelClass = {
    required: 'bg-knowledge text-white dark:text-[oklch(0.2_0.03_290)]',
    preferred: 'bg-knowledge-soft text-knowledge',
    keep: 'border text-muted-foreground',
  } as const

  return (
    <section className="overflow-x-clip border-t py-24 sm:py-32" aria-labelledby="knowledge-title">
      <Container>
        <div className="grid items-center gap-12 lg:grid-cols-12 lg:gap-16">
          <Reveal className="lg:col-span-6">
            <SectionHeading
              id="knowledge-title"
              tone="knowledge"
              kicker={knowledge.kicker}
              title={knowledge.title}
              body={knowledge.body}
            />
            <dl className="mt-10 grid gap-6 sm:grid-cols-3 lg:grid-cols-1">
              {knowledge.items.map((item) => (
                <div key={item.title} className="border-l-2 border-knowledge/40 pl-4">
                  <dt className="font-semibold">{item.title}</dt>
                  <dd className="mt-1 text-sm leading-6 text-muted-foreground">{item.body}</dd>
                </div>
              ))}
            </dl>
          </Reveal>

          <Reveal className="lg:col-span-6" delay={0.08}>
            <div className="relative">
              <div
                className="absolute -inset-6 -z-10 rounded-[2rem] bg-knowledge-soft/70 blur-2xl sm:-inset-10"
                aria-hidden="true"
              />
              <figure className="shot overflow-hidden rounded-2xl border bg-card" aria-label={table.name}>
                <div className="flex items-center gap-3 border-b px-5 py-4">
                  <span className="inline-flex size-9 items-center justify-center rounded-lg bg-knowledge-soft text-knowledge">
                    <BookOpen className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{table.name}</p>
                    <p className="text-xs text-muted-foreground">{table.direction}</p>
                  </div>
                  <ShieldCheck className="ml-auto size-4 text-knowledge" aria-hidden="true" />
                </div>
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="border-b">
                      {table.columns.map((column, index) => (
                        <th key={column} scope="col" className={cx('px-5 py-2.5 font-medium', index === 2 && 'text-right')}>
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map(([source, target, level]) => (
                      <tr key={source} className="border-b last:border-b-0">
                        <td className="px-5 py-3 font-medium" lang="ja">
                          {source}
                        </td>
                        <td className="px-5 py-3">{target}</td>
                        <td className="px-5 py-3 text-right">
                          <span
                            className={cx(
                              'inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
                              levelClass[level],
                            )}
                          >
                            {table.levels[level]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="border-t bg-surface px-5 py-3 text-xs text-muted-foreground">{table.footer}</p>
              </figure>
            </div>
          </Reveal>
        </div>
      </Container>
    </section>
  )
}

export function Tools() {
  const { t } = useSite()
  const { tools } = t
  return (
    <section className="border-t bg-surface py-24 sm:py-32" aria-labelledby="tools-title">
      <Container>
        <Reveal>
          <SectionHeading id="tools-title" kicker={tools.kicker} title={tools.title} body={tools.body} />
        </Reveal>
        <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {tools.items.map((tool, index) => {
            const Icon = TOOL_ICONS[tool.key]
            return (
              <Reveal
                as="li"
                key={tool.key}
                delay={(index % 4) * 0.04}
                className="flex h-full flex-col rounded-2xl border bg-card p-6"
              >
                  <Icon className="size-5" strokeWidth={1.75} aria-hidden="true" />
                  <h3 className="mt-5 flex items-center gap-2 font-semibold">
                    {tool.title}
                    {tool.beta && (
                      <span className="rounded-full border px-1.5 py-px text-[11px] font-medium text-muted-foreground">
                        {tool.beta}
                      </span>
                    )}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{tool.body}</p>
              </Reveal>
            )
          })}
          <Reveal
            as="li"
            delay={0.12}
            // Six tools leave two cells: the extras fill them, so both rows end flush.
            className="flex h-full flex-col rounded-2xl border border-dashed p-6 sm:col-span-2"
          >
            <Plus className="size-5 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
            <h3 className="mt-5 font-semibold">{tools.extrasTitle}</h3>
            <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm leading-6 text-muted-foreground sm:grid-cols-2">
              {tools.extras.map((extra) => (
                <li key={extra}>{extra}</li>
              ))}
            </ul>
          </Reveal>
        </ul>
      </Container>
    </section>
  )
}

export function Privacy() {
  const { t } = useSite()
  const { privacy } = t
  return (
    <section id="privacy" className="border-t py-24 sm:py-32" aria-labelledby="privacy-title">
      <Container>
        <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
          <Reveal className="lg:col-span-5">
            <SectionHeading id="privacy-title" kicker={privacy.kicker} title={privacy.title} body={privacy.body} />
            <p className="mt-8 flex gap-3 rounded-xl border bg-surface p-4 text-sm leading-6 text-muted-foreground">
              <KeyRound className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden="true" />
              {privacy.keys}
            </p>
          </Reveal>
          <Reveal className="lg:col-span-7" delay={0.08}>
            <dl className="divide-y border-y">
              {privacy.rows.map(([when, what]) => (
                <div key={when} className="grid gap-1 py-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-6">
                  <dt className="font-medium">{when}</dt>
                  <dd className="text-sm leading-6 text-muted-foreground">{what}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>
      </Container>
    </section>
  )
}
