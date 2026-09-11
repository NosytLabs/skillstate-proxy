"""Offline Chromium checks for the actual static documentation page.

Requires Python Playwright and a Chromium installation. This tests presentation,
not the inference runtime or the public GitHub Pages deployment.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
OUTPUT = Path(os.environ.get('DOCS_LAYOUT_OUTPUT', '/tmp/skillstate-docs-layout'))


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as p:
        executable = os.environ.get('CHROMIUM_EXECUTABLE')
        browser = p.chromium.launch(**({'executable_path': executable} if executable else {}))
        try:
            for width in (320, 390, 768, 1440):
                context = browser.new_context(viewport={'width': width, 'height': 900}, reduced_motion='reduce')
                context.route('**/*', lambda route: route.abort())
                page = context.new_page()
                errors: list[str] = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                # Render repository-owned content in memory; no file:// or network access.
                html = (DOCS / 'index.html').read_text(encoding='utf-8')
                html = re.sub(r'<link\b[^>]*rel="stylesheet"[^>]*>', '', html)
                page.set_content(html)
                page.add_style_tag(content=(DOCS / 'styles.css').read_text(encoding='utf-8'))
                page.locator('h1').wait_for()
                assert page.locator('h1').count() == 1
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'{width}: document overflow'
                positions = page.evaluate('''() => [document.querySelector('.mark'), document.querySelector('h1'), document.querySelector('.footer-inner p')].map(el => el.getBoundingClientRect().left)''')
                assert max(positions) - min(positions) < 2, f'{width}: header/main/footer are misaligned: {positions}'
                page.keyboard.press('Tab')
                assert page.locator('.skip-link').evaluate('(el) => el === document.activeElement')
                page.keyboard.press('Enter')
                assert page.locator('#main-content').evaluate('(el) => el === document.activeElement')
                for target in ('install', 'api', 'config', 'limits'):
                    page.locator(f'header a[href="#{target}"]').click()
                    box = page.locator(f'#{target} h2').bounding_box()
                    assert box and box['y'] >= -1, f'{width}: obscured {target} heading'
                for region in page.locator('.table-wrap').all():
                    region.focus()
                    overflow = region.evaluate('(el) => el.scrollWidth > el.clientWidth + 1')
                    if overflow:
                        region.press('ArrowRight')
                        page.wait_for_function('el => el.scrollLeft > 0', arg=region.element_handle())
                    region.evaluate('(el) => {el.scrollLeft = 0}')
                page.evaluate('window.scrollTo(0, 0)')
                page.screenshot(path=str(OUTPUT / f'page-{width}.png'), full_page=True)
                assert not errors, f'{width}: browser errors: {errors}'
                results.append({'width': width, 'overflow': False, 'aligned': True, 'skip_link': True, 'section_links': True, 'tables_keyboard_scrollable': True, 'browser_errors': errors})
                context.close()
        finally:
            browser.close()
    (OUTPUT / 'results.json').write_text(json.dumps(results, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'checked_viewports': len(results), 'results': results}, indent=2))


if __name__ == '__main__':
    main()
