import { useState } from 'react';

/**
 * The `useState(initialShape)` + `setFormData({ ...formData, field: value })`
 * pattern repeated in every modal/form across this app (EditProctorModal,
 * CustomersPage's add/edit form, WorkspacePage's reschedule/note modals, etc).
 * Just the form-state half -- submit/validation stays with the caller, since
 * that varies too much between forms (sync validation vs async duplicate
 * checks, parent-owned mutation vs a mutation the form owns itself) to force
 * into one shape.
 */
export function useFormState<T extends Record<string, any>>(initial: T) {
  const [formData, setFormData] = useState<T>(initial);

  const setField = <K extends keyof T>(field: K, value: T[K]) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const reset = () => setFormData(initial);

  return { formData, setFormData, setField, reset };
}
