import { useMemo, useState } from 'react';
import type { DemoDataset, DemoService, Meal } from '../contracts/demo.js';
import type { HallSettings, MealTime } from '../contracts/schedule.js';
import { demoSuggestion, filterServices, groupTrend, summarize } from '../analytics/demo.js';
import { dateLabel, datesInRange, dayNames, defaultSettings, displayServices, loadSettings, mealNames, scheduleForDate, shiftDate, timeLabel, validateSettings } from './helpers.js';

type Page = 'Dashboard' | 'Menus' | 'Schedule' | 'Settings';
type LocalMenus = Record<string, Partial<Record<Meal, string[]>>>;
const meals: Meal[] = ['breakfast', 'lunch', 'dinner'];
const percent = (value: number | null) => value === null ? 'No readings' : `${value.toFixed(1)}%`;
const count = (value: number) => value.toLocaleString('en-US');

function readMenus(): LocalMenus {
  try {
    const data = JSON.parse(localStorage.getItem('scrap-saver-menus-v1') || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    for (const values of Object.values(data)) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
      for (const items of Object.values(values)) if (!Array.isArray(items) || items.some(item => typeof item !== 'string')) return {};
    }
    return data;
  } catch { return {}; }
}

function downloadCsv(rows: (string | number)[][], name: string) {
  const csv = rows.map(row => row.map(cell => {
    const value = String(cell).replace(/^[=+@\-\t\r]/, "'$&");
    return `"${value.replaceAll('"', '""')}"`;
  }).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function DailyChart({ services, end, days }: { services: DemoService[]; end: string; days: number }) {
  const points = useMemo(() => {
    const daily = new Map(groupTrend(services).map(day => [day.date, day]));
    return datesInRange(end, days).map(date => ({ date, summary: daily.get(date) }));
  }, [services, end, days]);
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const active = points.find(point => point.date === activeDate);
  const x = (index: number) => days === 1 ? 510 : 70 + index * 850 / (days - 1);
  const y = (value: number) => 240 - 2 * value;
  let path = '';
  let connected = false;
  points.forEach((point, index) => {
    const value = point.summary?.averagePlateWastePercent ?? null;
    if (value === null) { connected = false; return; }
    path += `${connected ? 'L' : 'M'}${x(index)},${y(value)} `;
    connected = true;
  });
  const labelIndexes = [...new Set([0, Math.floor((days - 1) / 2), days - 1])];
  const dataDays = points.filter(point => point.summary?.averagedPlates).length;
  return <section className="section" aria-labelledby="trend-title">
    <h2 id="trend-title">Food left changes from day to day.</h2>
    <p>Average food left on each checked plate. Clean plates count as 0%.</p>
    <figure>
      <div className="chart-scroll">
        <svg className="chart" viewBox="0 0 960 290" role="img" aria-label={`Daily average food left, ${dateLabel(points[0].date)} through ${dateLabel(end)}. ${dataDays} of ${days} days have readings.`}>
          {[0, 25, 50, 75, 100].map(value => <g key={value}>
            <line x1="70" x2="920" y1={y(value)} y2={y(value)} stroke="black" strokeDasharray="2 6" strokeWidth="0.5" />
            <text x="56" y={y(value) + 5} textAnchor="end">{value}%</text>
          </g>)}
          <path d={path} fill="none" stroke="black" strokeWidth="2" />
          {points.map((point, index) => point.summary?.averagePlateWastePercent != null && <circle key={point.date}
            cx={x(index)} cy={y(point.summary.averagePlateWastePercent)} r="5" fill="black" tabIndex={0}
            aria-label={`${dateLabel(point.date)}: ${percent(point.summary.averagePlateWastePercent)}, ${point.summary.averagedPlates} plates`}
            onMouseEnter={() => setActiveDate(point.date)} onMouseLeave={() => setActiveDate(null)}
            onFocus={() => setActiveDate(point.date)} onBlur={() => setActiveDate(null)}>
            <title>{dateLabel(point.date)}: {percent(point.summary.averagePlateWastePercent)}</title>
          </circle>)}
          {labelIndexes.map(index => <text key={index} x={x(index)} y="275" textAnchor="middle">{dateLabel(points[index].date, true)}</text>)}
        </svg>
      </div>
      <p className="chart-reading" aria-live="polite">{active?.summary
        ? `${dateLabel(active.date)}: ${percent(active.summary.averagePlateWastePercent)} food left, ${count(active.summary.averagedPlates)} plates checked.`
        : `${dataDays} of ${days} days have readings. Days without readings are left blank.`}</p>
      <figcaption>Source: sample plate records, {dateLabel(end)}. All readings are demo estimates.</figcaption>
    </figure>
    <details><summary>See daily numbers</summary>
      <div className="table-scroll"><table><thead><tr><th scope="col">Date</th><th scope="col">Average food left</th><th scope="col">Plates checked</th><th scope="col">Clean plates</th><th scope="col">Not counted</th></tr></thead>
        <tbody>{points.map(point => <tr key={point.date}><th scope="row">{dateLabel(point.date, true)}</th><td>{percent(point.summary?.averagePlateWastePercent ?? null)}</td><td>{point.summary?.averagedPlates ?? 0}</td><td>{point.summary?.cleanPlates ?? 0}</td><td>{point.summary?.excludedPlates ?? 0}</td></tr>)}</tbody></table></div>
    </details>
  </section>;
}

function Calendar({ date, onSelect, services, settings }: { date: string; onSelect: (date: string) => void; services: DemoService[]; settings: HallSettings }) {
  const [month, setMonth] = useState(date.slice(0, 7));
  const first = `${month}-01`;
  const offset = new Date(`${first}T12:00:00Z`).getUTCDay();
  const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const records = new Set(services.map(service => service.localDate));
  const navigate = (direction: number) => {
    const value = new Date(`${first}T12:00:00Z`);
    value.setUTCMonth(value.getUTCMonth() + direction);
    setMonth(value.toISOString().slice(0, 7));
  };
  return <div className="calendar">
    <div className="calendar-heading"><button onClick={() => navigate(-1)} aria-label="Previous month">Previous</button><h2>{new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${first}T12:00:00Z`))}</h2><button onClick={() => navigate(1)} aria-label="Next month">Next</button></div>
    <div className="calendar-grid">
      {dayNames.map(day => <span className="weekday" key={day}><abbr title={day}>{day.slice(0, 3)}</abbr></span>)}
      {Array.from({ length: offset }, (_, index) => <span key={`blank-${index}`} />)}
      {Array.from({ length: days }, (_, index) => {
        const value = `${month}-${String(index + 1).padStart(2, '0')}`;
        const event = settings.events.find(event => event.date === value);
        return <button key={value} aria-pressed={date === value} aria-label={`${dateLabel(value)}${event ? `, ${event.name}` : ''}${records.has(value) ? ', readings available' : ', no readings'}`}
          className="calendar-day" onClick={() => onSelect(value)}><span>{index + 1}</span><small>{event ? 'Event' : records.has(value) ? 'Readings' : ''}</small></button>;
      })}
    </div>
    <p>Choose a day to see meal times and suggestions.</p>
  </div>;
}

function Schedule({ services, settings, date, onSelect, openSettings }: { services: DemoService[]; settings: HallSettings; date: string; onSelect: (date: string) => void; openSettings: () => void }) {
  const [meal, setMeal] = useState<Meal | 'all'>('all');
  const selected = filterServices(services, date, date).filter(service => meal === 'all' || service.meal === meal);
  const summary = summarize(selected);
  const times = scheduleForDate(settings, date);
  const top = summary.foods[0];
  return <>
    <h1>Plan the next meal with what plates show.</h1>
    <Calendar date={date} onSelect={onSelect} services={services} settings={settings} />
    <section className="section" aria-labelledby="selected-day"><h2 id="selected-day">{dateLabel(date)}</h2>
      {times ? <><h3>{times.name}{times.isEvent ? ' event' : ' meal times'}</h3><ul className="times-list">{times.meals.map(slot => <li key={slot.id}><strong>{slot.name}</strong> {timeLabel(slot.start)} to {timeLabel(slot.end)}</li>)}</ul></> : <p>No meal times set for this day.</p>}
      <button onClick={openSettings}>Edit meal times in Settings</button>
    </section>
    <section className="section" aria-labelledby="suggestion-title">
      <div className="section-heading"><h2 id="suggestion-title">{top && top.remainingAreaPx > 0 ? `${top.name} left the most food behind.` : summary.averagedPlates ? 'The checked plates came back clean.' : 'This day needs more readings.'}</h2>
        <label>Meal <select value={meal} onChange={event => setMeal(event.target.value as Meal | 'all')}><option value="all">All meals</option>{meals.map(value => <option value={value} key={value}>{mealNames[value]}</option>)}</select></label>
      </div>
      {summary.averagedPlates ? <>
        <p className="suggestion">{demoSuggestion(summary)}</p>
        <p className="source">Demo suggestion based on {count(summary.averagedPlates)} checked plates. This sample does not tell us why food was left.</p>
        <dl className="facts"><div><dt>Average food left</dt><dd>{percent(summary.averagePlateWastePercent)}</dd></div><div><dt>Plates checked</dt><dd>{count(summary.averagedPlates)}</dd></div><div><dt>Clean plates</dt><dd>{count(summary.cleanPlates)}</dd></div><div><dt>Not counted</dt><dd>{count(summary.excludedPlates)}</dd></div></dl>
        {summary.foods.length > 0 && <div className="table-scroll"><table><caption>These foods made up the leftovers.</caption><thead><tr><th scope="col">Food</th><th scope="col">Share of leftovers</th><th scope="col">Servings checked</th></tr></thead><tbody>{summary.foods.slice(0, 5).map(food => <tr key={food.id}><th scope="row">{food.name}</th><td>{food.sharePercent.toFixed(1)}%</td><td>{food.assessedServings}</td></tr>)}</tbody></table></div>}
        <p>Demo guest count: {summary.attendance === null ? 'Unavailable' : count(summary.attendance)}. Guest counts are simulated and are separate from plates checked.</p>
      </> : <p>{selected.length ? 'Plate readings could not be used. Check the camera and food names before changing portions.' : 'No plate readings for this day. Choose a day marked Readings to see a suggestion.'}</p>}
    </section>
  </>;
}

function MealEditor({ meals: slots, onChange }: { meals: MealTime[]; onChange: (slots: MealTime[]) => void }) {
  return <><div className="meal-slots">{slots.map((slot, index) => <div className="meal-slot" key={slot.id}>
    <label>Meal name<input required maxLength={80} value={slot.name} onChange={event => onChange(slots.map((candidate, i) => i === index ? { ...candidate, name: event.target.value } : candidate))} /></label>
    <label>Starts<input required type="time" value={slot.start} onChange={event => onChange(slots.map((candidate, i) => i === index ? { ...candidate, start: event.target.value } : candidate))} /></label>
    <label>Ends<input required type="time" value={slot.end} onChange={event => onChange(slots.map((candidate, i) => i === index ? { ...candidate, end: event.target.value } : candidate))} /></label>
    <button type="button" onClick={() => onChange(slots.filter((_, i) => i !== index))} aria-label={`Remove ${slot.name || 'meal'} time`}>Remove</button>
  </div>)}</div><button type="button" onClick={() => onChange([...slots, { id: crypto.randomUUID(), name: '', start: '12:00', end: '14:00' }])}>Add a meal time</button></>;
}

function Settings({ settings, onSave }: { settings: HallSettings; onSave: (value: HallSettings) => void }) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [message, setMessage] = useState('');
  const change = (next: HallSettings) => { setDraft(next); setMessage(''); };
  return <><h1>Set meal times for each kind of day.</h1><p>Save regular hours and exceptions such as football games.</p>
    <form onSubmit={event => {
      event.preventDefault();
      const error = validateSettings(draft);
      if (error) { setMessage(error); return; }
      try { localStorage.setItem('scrap-saver-settings-v1', JSON.stringify(draft)); onSave(structuredClone(draft)); setMessage('Settings saved in this browser.'); }
      catch { setMessage('Settings could not be saved. Allow this site to save data in your browser, then try again.'); }
    }}>
      <label className="hall-name">Dining hall name<input required maxLength={120} value={draft.hallName} onChange={event => change({ ...draft, hallName: event.target.value })} /></label>
      <section className="section"><h2>Different days can have different hours.</h2>
        {draft.schedules.map((schedule, index) => <fieldset className="schedule-editor" key={schedule.id}><legend>{schedule.name || 'New regular schedule'}</legend>
          <label>Schedule name<input required maxLength={80} value={schedule.name} onChange={event => change({ ...draft, schedules: draft.schedules.map((value, i) => i === index ? { ...value, name: event.target.value } : value) })} /></label>
          <div className="day-choices" role="group" aria-label={`Days for ${schedule.name || 'new schedule'}`}>{dayNames.map((day, dayIndex) => <label key={day}><input type="checkbox" checked={schedule.days.includes(dayIndex)} onChange={event => change({ ...draft, schedules: draft.schedules.map((value, i) => i === index ? { ...value, days: event.target.checked ? [...value.days, dayIndex] : value.days.filter(day => day !== dayIndex) } : value) })} />{day}</label>)}</div>
          <MealEditor meals={schedule.meals} onChange={slots => change({ ...draft, schedules: draft.schedules.map((value, i) => i === index ? { ...value, meals: slots } : value) })} />
          <button type="button" className="remove-schedule" onClick={() => change({ ...draft, schedules: draft.schedules.filter((_, i) => i !== index) })}>Remove regular schedule</button>
        </fieldset>)}
        <button type="button" onClick={() => change({ ...draft, schedules: [...draft.schedules, { id: crypto.randomUUID(), name: '', days: [], meals: [{ id: crypto.randomUUID(), name: 'Lunch', start: '11:00', end: '14:00' }] }] })}>Add a regular schedule</button>
      </section>
      <section className="section"><h2>Events can have their own meal times.</h2><p>An event replaces the regular hours for its date.</p>
        {draft.events.length === 0 && <p>No events added.</p>}
        {draft.events.map((event, index) => <fieldset className="schedule-editor" key={event.id}><legend>{event.name || 'New event'}</legend>
          <div className="event-fields"><label>Event name<input required maxLength={100} placeholder="Football game" value={event.name} onChange={input => change({ ...draft, events: draft.events.map((value, i) => i === index ? { ...value, name: input.target.value } : value) })} /></label>
            <label>Event date<input required type="date" value={event.date} onChange={input => change({ ...draft, events: draft.events.map((value, i) => i === index ? { ...value, date: input.target.value } : value) })} /></label></div>
          <MealEditor meals={event.meals} onChange={slots => change({ ...draft, events: draft.events.map((value, i) => i === index ? { ...value, meals: slots } : value) })} />
          <button type="button" className="remove-schedule" onClick={() => change({ ...draft, events: draft.events.filter((_, i) => i !== index) })}>Remove event</button>
        </fieldset>)}
        <button type="button" onClick={() => change({ ...draft, events: [...draft.events, { id: crypto.randomUUID(), name: '', date: '', meals: [{ id: crypto.randomUUID(), name: 'Game day meal', start: '11:00', end: '15:00' }] }] })}>Add an event</button>
      </section>
      <div className="save-row"><button type="submit">Save settings</button><p role="status">{message}</p></div>
      <p className="source">These settings stay in this browser. Sample plate records keep their original meal dates.</p>
    </form>
  </>;
}

function Menus({ services, end }: { services: DemoService[]; end: string }) {
  const [saved, setSaved] = useState(readMenus);
  const [date, setDate] = useState(end);
  const [meal, setMeal] = useState<Meal>('lunch');
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const itemsFor = (date: string, meal: Meal) => saved[date]?.[meal] ?? services.find(service => service.localDate === date && service.meal === meal)?.items.map(item => item.name) ?? [];
  const select = (newDate: string, newMeal: Meal) => { setDate(newDate); setMeal(newMeal); setText(itemsFor(newDate, newMeal).join('\n')); setMessage(''); };
  return <><h1>Keep each day's food names together.</h1><p>Add food names yourself. One food per line.</p>
    <form className="section" onSubmit={event => {
      event.preventDefault();
      const items = [...new Set(text.split('\n').map(item => item.trim()).filter(Boolean))];
      if (!items.length) { setMessage('Add at least one food name.'); return; }
      if (items.length > 100 || items.some(item => item.length > 160)) { setMessage('Use up to 100 foods, with short names.'); return; }
      const next = { ...saved, [date]: { ...saved[date], [meal]: items } };
      try { localStorage.setItem('scrap-saver-menus-v1', JSON.stringify(next)); setSaved(next); setMessage('Menu saved in this browser.'); }
      catch { setMessage('The menu could not be saved. Allow this site to save browser data, then try again.'); }
    }}>
      <div className="filters"><label>Date<input type="date" required value={date} onChange={event => select(event.target.value || end, meal)} /></label><label>Meal<select value={meal} onChange={event => select(date, event.target.value as Meal)}>{meals.map(value => <option value={value} key={value}>{mealNames[value]}</option>)}</select></label></div>
      <label>Food names<textarea rows={6} maxLength={16000} value={text} placeholder="Margherita flatbread&#10;Garden salad" onChange={event => { setText(event.target.value); setMessage(''); }} /></label>
      <div className="save-row"><button type="submit">Save menu</button><button type="button" onClick={() => select(date, meal)}>Use this day's saved menu</button><p role="status">{message}</p></div>
    </form>
    <section className="section"><h2>{dateLabel(date)} has these menus.</h2><div className="menu-columns">{meals.map(value => <div key={value}><h3>{mealNames[value]}</h3><p>{saved[date]?.[value] ? 'Saved in this browser' : 'Sample menu'}</p>{itemsFor(date, value).length ? <ul>{itemsFor(date, value).map(item => <li key={item}>{item}</li>)}</ul> : <p>No menu yet. Add the food names above.</p>}</div>)}</div></section>
    <p className="source">New menus stay in this browser. Demo results use the original sample menus.</p>
  </>;
}

export default function App({ dataset }: { dataset: DemoDataset }) {
  const services = useMemo(() => displayServices(dataset.services), [dataset]);
  const [page, setPage] = useState<Page>('Dashboard');
  const [settings, setSettings] = useState(() => { try { return loadSettings(localStorage, dataset.hall.name); } catch { return defaultSettings(dataset.hall.name); } });
  const [end, setEnd] = useState(dataset.window.end);
  const [lookback, setLookback] = useState(7);
  const [scheduleDate, setScheduleDate] = useState(dataset.window.end);
  const selected = useMemo(() => filterServices(services, shiftDate(end, 1 - lookback), end), [services, end, lookback]);
  const today = summarize(filterServices(services, dataset.window.end, dataset.window.end));
  const cards = [{ label: "Today's waste", days: 1, summary: today }, { label: "This week's waste", days: 7, summary: summarize(filterServices(services, shiftDate(dataset.window.end, -6), dataset.window.end)) }, { label: "This month's waste", days: 30, summary: summarize(filterServices(services, shiftDate(dataset.window.end, -29), dataset.window.end)) }];
  const changePage = (value: Page) => { setPage(value); window.scrollTo({ top: 0 }); };
  return <div className="app">
    <header className="site-header"><a className="brand" href="#dashboard" onClick={event => { event.preventDefault(); changePage('Dashboard'); }}>Scrap Saver</a><span>{settings.hallName}</span>
      <nav aria-label="Main navigation">{(['Dashboard', 'Menus', 'Schedule', 'Settings'] as Page[]).map(value => <button key={value} aria-current={page === value ? 'page' : undefined} onClick={() => changePage(value)}>{value}</button>)}</nav>
    </header>
    <p className="demo-notice">Demo data: {dateLabel(dataset.window.start)} to {dateLabel(dataset.window.end)}. Food readings are estimates. Guest counts are simulated.</p>
    <main id="main">
      {page === 'Dashboard' && <>
        <h1>{today.averagePlateWastePercent === null ? 'Check what food comes back on plates.' : `Plates came back with ${percent(today.averagePlateWastePercent)} left today.`}</h1>
        <p>Average food left per checked plate, including clean plates at 0%.</p>
        <div className="metrics">{cards.map(card => {
          const dataDays = new Set(filterServices(services, shiftDate(dataset.window.end, 1 - card.days), dataset.window.end).filter(service => service.captures.length).map(service => service.localDate)).size;
          return <section className="metric" key={card.label} aria-label={card.label}><h2>{card.label}</h2><p className="metric-number">{percent(card.summary.averagePlateWastePercent)}</p><p>{count(card.summary.averagedPlates)} plates checked, {count(card.summary.cleanPlates)} clean</p><p>{count(card.summary.excludedPlates)} readings not counted</p>{card.days > 1 && <p>{dataDays} of {card.days} days available</p>}</section>;
        })}</div>
        <section className="filters section" aria-label="Chart dates"><label>Show<select value={lookback} onChange={event => setLookback(Number(event.target.value))}><option value={1}>One day</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label><label>Ending on<input type="date" required value={end} onChange={event => { if (event.target.value) setEnd(event.target.value); }} /></label></section>
        <DailyChart services={selected} end={end} days={lookback} />
        <section className="section"><h2>Keep the daily plate counts.</h2><p>Download the dates, average food left, clean plates, and readings not counted.</p><button onClick={() => {
          const daily = new Map(groupTrend(selected).map(day => [day.date, day]));
          downloadCsv([['Date', 'Average food left (%)', 'Plates checked', 'Clean plates', 'Readings not counted', 'Source'], ...datesInRange(end, lookback).map(date => { const day = daily.get(date); return [date, day?.averagePlateWastePercent?.toFixed(2) ?? '', day?.averagedPlates ?? 0, day?.cleanPlates ?? 0, day?.excludedPlates ?? 0, 'Synthetic demo estimates']; })], 'scrap-saver-daily-report.csv');
        }}>Download daily report</button><p className="source">Source: sample plate records. Missing readings stay blank.</p></section>
      </>}
      {page === 'Schedule' && <Schedule services={services} settings={settings} date={scheduleDate} onSelect={setScheduleDate} openSettings={() => changePage('Settings')} />}
      {page === 'Settings' && <Settings settings={settings} onSave={setSettings} />}
      {page === 'Menus' && <Menus services={services} end={dataset.window.end} />}
    </main>
  </div>;
}
