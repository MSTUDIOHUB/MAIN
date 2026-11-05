import { expect, test, type Page } from "@playwright/test";

async function mountSwitchFixture(page: Page, theme: string) {
  // Reuse Vite's real React module URLs and refresh preamble so this isolated
  // component fixture has the same React instance and theme CSS as the app.
  const html = await (await page.request.get("/")).text();
  const main = await (await page.request.get("/src/main.tsx")).text();
  const moduleUrl = (file: string) => {
    const url = [...main.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])
      .find((url) => url.split("?")[0].endsWith(`/${file}`));
    if (!url) throw new Error(`Vite did not expose ${file} for the switch fixture`);
    return url;
  };
  const script = `
    import React from ${JSON.stringify(moduleUrl("react.js"))};
    import ReactDOM from ${JSON.stringify(moduleUrl("react-dom_client.js"))};
    import ToggleSwitch from "/src/components/ToggleSwitch.tsx";
    import ThemeStyles from "/src/components/ThemeStyles.tsx";
    import { useAppStore } from "/src/store/useAppStore.ts";
    import "/src/index.css";
    import "/src/App.css";
    useAppStore.setState({ config: { ...useAppStore.getState().config, theme: "purple", themeMode: ${JSON.stringify(theme)} } });
    const h = React.createElement;
    const root = ReactDOM.createRoot(document.getElementById("root"));
    let checked = false;
    let calls = [];
    let submits = 0;
    const render = () => root.render(h(React.Fragment, null,
      h(ThemeStyles),
      h("form", { "data-testid": "switch-fixture", onSubmit: event => { event.preventDefault(); submits++; render(); }, style: { margin: "40px", padding: "24px", width: "420px", borderRadius: "12px", border: "1px solid var(--surface-border)", background: "var(--surface-1)", color: "var(--surface-text)" } },
        h("h1", { style: { marginBottom: "24px", fontSize: "16px" } }, "Shared setting switches"),
        h("div", { style: { display: "flex", gap: "16px", alignItems: "center", marginBottom: "20px" } },
          h("label", { htmlFor: "fixture-enabled" }, "Feature enabled"),
          h(ToggleSwitch, { id: "fixture-enabled", checked, onCheckedChange: next => { checked = next; calls.push(next); render(); } })),
        h("div", { style: { display: "flex", gap: "16px", alignItems: "center", marginBottom: "20px" } },
          h("label", { htmlFor: "fixture-disabled" }, "Unavailable feature"),
          h(ToggleSwitch, { id: "fixture-disabled", checked: true, disabled: true, onCheckedChange: () => { calls.push("disabled"); render(); } })),
        h("output", { "data-testid": "switch-events", style: { display: "block", fontSize: "12px" } }, JSON.stringify({ calls, submits }))
      )));
    render();
  `;
  const entry = /<script\b[^>]*\bsrc=["']\/src\/main\.tsx(?:\?[^"']*)?["'][^>]*>\s*<\/script>/i;
  if (!entry.test(html)) throw new Error("Vite app entry is unavailable for switch fixture");
  await page.addInitScript(() => localStorage.clear());
  await page.route("**/__toggle-switch-fixture__", (route) => route.fulfill({
    contentType: "text/html", body: html.replace(entry, `<script type="module">${script}</script>`),
  }));
  await page.goto("/__toggle-switch-fixture__");
  await expect(page.getByRole("switch", { name: "Feature enabled", exact: true })).toBeVisible();
}

for (const theme of ["light", "dark", "black"]) {
  test(`shared capsule switch supports labels, keyboard, focus and disabled state in ${theme}`, async ({ page }, testInfo) => {
    await mountSwitchFixture(page, theme);
    const enabled = page.getByRole("switch", { name: "Feature enabled", exact: true });
    const disabled = page.getByRole("switch", { name: "Unavailable feature", exact: true });
    await expect(enabled).not.toBeChecked();
    await expect(disabled).toBeChecked();
    await expect(disabled).toBeDisabled();
    const disabledBackground = await disabled.evaluate((button) => getComputedStyle(button).backgroundColor);
    await disabled.hover();
    await expect(disabled).toHaveCSS("background-color", disabledBackground);
    await enabled.focus();
    await enabled.press("Space");
    await expect(enabled).toBeChecked();
    await enabled.press("Enter");
    await expect(enabled).not.toBeChecked();
    await page.getByText("Feature enabled", { exact: true }).click();
    await expect(enabled).toBeChecked();
    await disabled.dispatchEvent("click");
    await expect(page.getByTestId("switch-events")).toHaveText('{"calls":[true,false,true],"submits":0}');
    const geometry = await enabled.evaluate((button) => {
      const style = getComputedStyle(button);
      const bounds = button.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height, radius: parseFloat(style.borderRadius) };
    });
    expect(geometry.width).toBeGreaterThan(geometry.height);
    expect(geometry.radius).toBeGreaterThanOrEqual(geometry.height / 2);
    await enabled.focus();
    await enabled.press("Space");
    await expect(enabled).not.toBeChecked();
    await expect(enabled).toHaveCSS("outline-style", "solid");
    await page.getByTestId("switch-fixture").screenshot({ path: testInfo.outputPath(`toggle-switch-${theme}.png`), animations: "disabled" });
  });
}
