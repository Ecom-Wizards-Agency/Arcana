import Queue from './queue';
import './view.css';
import type { load } from './load';
export type ScreenData = Awaited<ReturnType<typeof load>>;
export default function ScreenView({ data }: { data: ScreenData }) { return <Queue data={data}/>; }
