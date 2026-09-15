import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "map": () => ([]), "board": { "open": [], "inProgress": [], "fixed": [], "declined": [], "duplicates": [] }, "role": "owner" } } satisfies ScreenData;
