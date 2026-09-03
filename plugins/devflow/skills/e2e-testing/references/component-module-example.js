// Reusable modules receive the caller's page/context and explicit arguments.
// They do not create a browser, own Case data, or decide the final verdict.
async function openSampleDialog({ page, title }) {
  const trigger = page.getByRole('button', { name: title, exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await dialog.waitFor({ state: 'visible' });
  return dialog;
}

module.exports = { openSampleDialog };
