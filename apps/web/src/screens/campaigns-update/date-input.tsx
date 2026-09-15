'use client';
import { Input } from '../campaigns/ui';
import { formatShellDate, validShellDate } from '../../ui/date-format';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function calendarDateFromWords(value: string): string {
  const parts = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(value.trim());
  if (!parts) return value;
  const month = months.findIndex((name) => name.toLowerCase() === parts[2]!.toLowerCase()) + 1;
  const date = `${parts[3]}-${String(month).padStart(2, '0')}-${parts[1]!.padStart(2, '0')}`;
  return validShellDate(date) ? date : value;
}

export function CampaignEndDateInput({ id, value, disabled, onChange }: { id: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  return <Input id={id} disabled={disabled} placeholder="DD Mon YYYY" value={validShellDate(value) ? formatShellDate(value) : value}
    onChange={(event) => onChange(calendarDateFromWords(event.target.value))} />;
}
