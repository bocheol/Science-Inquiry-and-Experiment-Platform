import { createHash } from 'node:crypto';
import { getDb } from '@/lib/db';

export async function studentTextRedactor() {
  const db = await getDb();
  const people = await db.query<{ id: string; name: string; login_id: string }>('SELECT id, name, login_id FROM users ORDER BY id');
  const aliases = new Map(people.rows.map(p => [p.id, `참여자-${createHash('sha256').update(p.id).digest('hex').slice(0, 6)}`]));
  const replacements = people.rows.flatMap(p => [[p.name, aliases.get(p.id)!], [p.login_id, aliases.get(p.id)!]]).filter(([value]) => value.length >= 2).sort((a,b) => b[0].length-a[0].length);
  const redact = (text: string) => {
    for (const [value, alias] of replacements) text = text.split(value).join(alias);
    return text.replace(/\b\d{5}\b/g, '[번호]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[연락처]').replace(/01[016789][- .]?\d{3,4}[- .]?\d{4}/g, '[연락처]');
  };
  return { aliases, redact };
}
