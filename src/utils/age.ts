/**
 * Whole years between a date-of-birth string and today, correctly handling whether
 * this year's birthday has actually passed yet (a plain year subtraction over-counts
 * anyone whose birthday hasn't occurred yet this year). Shared by OnboardingFormPage
 * and AddProctorPage (individual add + CSV bulk import) -- the one age-eligibility
 * check both proctor-creation paths need, rather than two copies that can drift.
 *
 * Accepts both the ISO 'YYYY-MM-DD' a <input type="date"> produces and the loose
 * 'M/D/YY' style JS's Date constructor also parses (a real format already present in
 * this table from historical CSV imports) -- `new Date(...)` handles both.
 */
export function calculateAge(dob: string): number {
  const birthDate = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}
