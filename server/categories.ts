// The folders a new Paperwork folder starts with. After that, the folders in Drive are the categories: add them in
// the app (Settings › Folders; with DRIVE_ACCESS=full, folders added in Drive count too), rename or remove them in
// Drive and Paperwork follows. A folder's description in Drive (right-click > File information > Details) tells
// the AI what belongs there.

export interface CategorySeed {
  name: { en: string; de: string };
  description: string;
}

export const DEFAULT_CATEGORIES: CategorySeed[] = [
  {
    name: { en: 'Identity & Personal', de: 'Ausweise & Persönliches' },
    description: 'Passports, ID cards, birth and marriage certificates, residence registration, driving licences.',
  },
  {
    name: { en: 'Finance & Banking', de: 'Finanzen & Bank' },
    description: 'Bank and credit card statements, loans, mortgages, savings, investments, pensions.',
  },
  {
    name: { en: 'Taxes', de: 'Steuern' },
    description: 'Tax returns, tax assessments, annual tax certificates, donation receipts, anything for the tax office.',
  },
  {
    name: { en: 'Bills & Receipts', de: 'Rechnungen & Belege' },
    description: 'Invoices and receipts for purchases, utilities, phone, internet and subscriptions.',
  },
  {
    name: { en: 'Housing', de: 'Wohnen' },
    description: 'Rental agreements, service charge statements, utility contracts, property documents, handover protocols.',
  },
  {
    name: { en: 'Health', de: 'Gesundheit' },
    description: 'Doctor letters, lab results, prescriptions, vaccination records, hospital and therapy documents.',
  },
  {
    name: { en: 'Insurance', de: 'Versicherungen' },
    description: 'Insurance policies, premium notices, claims and letters from insurers (health, car, home, liability, life).',
  },
  {
    name: { en: 'Work', de: 'Arbeit' },
    description: 'Employment contracts, payslips, references, certificates from employers, company pension statements.',
  },
  {
    name: { en: 'Education', de: 'Bildung' },
    description: 'School and university certificates, transcripts, enrolment, courses and training.',
  },
  {
    name: { en: 'Vehicle', de: 'Fahrzeug' },
    description: 'Vehicle registration, purchase and leasing, service and repair records, inspections, fines.',
  },
  {
    name: { en: 'Legal & Government', de: 'Recht & Behörden' },
    description: 'Letters from authorities and public offices, court and lawyer correspondence, contracts that fit nowhere else.',
  },
  {
    name: { en: 'Travel', de: 'Reisen' },
    description: 'Bookings, tickets, itineraries, visas.',
  },
  {
    name: { en: 'Warranties & Manuals', de: 'Garantien & Anleitungen' },
    description: 'Warranty cards, product manuals, proof of purchase kept for a warranty.',
  },
  {
    name: { en: 'Other', de: 'Sonstiges' },
    description: 'Anything that fits no other folder.',
  },
];

export const SPECIAL_FOLDERS = {
  inbox: {
    name: { en: 'Inbox', de: 'Eingang' },
    description:
      'Put new documents here: upload them, or scan them with the Google Drive app. Paperwork names them, ' +
      'describes them and moves them into the right folder within a few minutes. Files it cannot read stay here.',
  },
  duplicates: {
    name: { en: 'Duplicates', de: 'Duplikate' },
    description:
      'Files that were already in Paperwork. Paperwork never deletes anything, so they wait here for you to delete them.',
  },
  root: {
    description:
      'Your documents, organized by Paperwork. Drop new ones into the Inbox folder. Each folder is a category; ' +
      'its description tells Paperwork what belongs there. Paperwork can add and organize files here but never deletes them.',
  },
};
