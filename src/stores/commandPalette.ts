import { create } from 'zustand';

/** Deliberately not persisted (unlike useUIStore) -- reloading with the palette
 * stuck open from a previous session would be a bug, not a convenience. */
interface CommandPaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
