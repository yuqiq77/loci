"use client";

import { useEffect, useState } from "react";

// One entry per day, so a month holds at most 31: one request covers it,
// and the newest 31 entries always include all of the newest month.
const MONTH_LIMIT = 31;

type DiaryEntryView = {
  id: string;
  entryDate: string;
  content: string;
  createdAt: string;
};

type DiaryMonth = { month: string; count: number };

type DiaryResponse = {
  months: DiaryMonth[];
  entries: DiaryEntryView[];
};

// entry_date is a plain YYYY-MM-DD (and a month YYYY-MM); building the Date
// from the parts at local noon keeps the label on the diary day itself (new
// Date("YYYY-MM-DD") is UTC midnight and can shift a day backward in
// western timezones).
function localNoon(year: number, month: number, day = 1): Date {
  return new Date(year, month - 1, day, 12);
}

function monthName(month: string): string {
  const [year, index] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long" }).format(
    localNoon(year, index),
  );
}

function weekday(entryDate: string): string {
  const [year, month, day] = entryDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(
    localNoon(year, month, day),
  );
}

export function DiaryList() {
  const [months, setMonths] = useState<DiaryMonth[]>([]);
  // requested: the month asked for (null = the newest); shown: the month of
  // the entries on screen.
  const [requested, setRequested] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [entries, setEntries] = useState<DiaryEntryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const query = requested ? `&month=${requested}` : "";
        const response = await fetch(
          `/api/diary?limit=${MONTH_LIMIT}${query}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          throw new Error("Unable to load entries.");
        }
        const loaded = (await response.json()) as DiaryResponse;
        if (!controller.signal.aborted) {
          const month = requested ?? loaded.months[0]?.month ?? null;
          setMonths(loaded.months);
          setShown(month);
          setEntries(
            loaded.entries.filter((entry) =>
              entry.entryDate.startsWith(`${month}-`),
            ),
          );
          setError(null);
        }
      } catch (loadError) {
        if (
          !(
            loadError instanceof DOMException &&
            loadError.name === "AbortError"
          )
        ) {
          setError("Unable to load entries.");
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    })();

    return () => controller.abort();
  }, [requested]);

  const active = requested ?? shown;

  function selectMonth(month: string) {
    if (month === active) {
      return;
    }
    setLoading(true);
    setRequested(month);
  }

  if (loading && months.length === 0) {
    return <p className="text-sm text-[var(--muted)]">Loading entries...</p>;
  }
  if (error && months.length === 0) {
    return (
      <p className="text-sm text-red-700" role="alert">
        {error}
      </p>
    );
  }
  if (months.length === 0 || !shown) {
    return (
      <p className="text-sm leading-relaxed text-stone-500">
        No entries yet. The first one is written the morning after a day of
        conversation.
      </p>
    );
  }

  const years = new Map<string, DiaryMonth[]>();
  for (const item of months) {
    const year = item.month.slice(0, 4);
    years.set(year, [...(years.get(year) ?? []), item]);
  }
  const count =
    months.find(({ month }) => month === shown)?.count ?? entries.length;

  return (
    <div className="md:grid md:grid-cols-[120px_minmax(0,1fr)] md:gap-12">
      <nav aria-label="Months" className="mb-8 md:mb-0">
        {[...years].map(([year, yearMonths]) => (
          <div className="mb-6" key={year}>
            <p className="mb-2 text-xs tracking-[0.2em] text-stone-500">
              {year}
            </p>
            <ul className="flex overflow-x-auto md:flex-col">
              {yearMonths.map(({ month }) => (
                <li key={month}>
                  <button
                    aria-current={month === active ? "true" : undefined}
                    className={`block w-full whitespace-nowrap border-b-2 px-3 py-2 text-left text-[15px] transition-colors md:border-b-0 md:border-l-2 md:py-3 md:pl-4 md:pr-0 ${
                      month === active
                        ? "border-accent-strong text-accent-strong"
                        : "border-transparent text-stone-500 hover:text-stone-800"
                    }`}
                    onClick={() => selectMonth(month)}
                    type="button"
                  >
                    {monthName(month)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <section
        aria-busy={loading}
        aria-labelledby="journal-month"
        className={`transition-opacity ${loading ? "opacity-50" : ""}`}
      >
        <h2
          className="font-serif text-[32px] leading-tight text-stone-900"
          id="journal-month"
        >
          {monthName(shown)}
        </h2>
        <p className="mt-2 text-sm text-stone-500">
          {count} {count === 1 ? "entry" : "entries"}
        </p>

        {error ? (
          <p className="mt-4 text-sm text-red-700" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-8 space-y-12 border-t border-stone-200 pt-10">
          {entries.map((entry) => (
            <article
              className="grid grid-cols-[48px_minmax(0,1fr)] gap-5 md:grid-cols-[64px_minmax(0,1fr)] md:gap-8"
              key={entry.id}
            >
              <time className="text-center" dateTime={entry.entryDate}>
                <span className="block font-serif text-[28px] leading-none text-stone-900">
                  {Number(entry.entryDate.slice(8))}
                </span>
                <span className="mt-3 block text-xs uppercase tracking-wide text-stone-500">
                  {weekday(entry.entryDate)}
                </span>
              </time>
              <p className="whitespace-pre-wrap font-serif text-[17px] leading-[1.9] text-stone-800">
                {entry.content}
              </p>
            </article>
          ))}
        </div>

        <p className="mt-14 flex items-center justify-center gap-4 font-serif text-[15px] italic text-stone-500">
          <span aria-hidden="true" className="h-px w-12 bg-stone-300" />
          End of {monthName(shown)}
          <span aria-hidden="true" className="h-px w-12 bg-stone-300" />
        </p>
      </section>
    </div>
  );
}
