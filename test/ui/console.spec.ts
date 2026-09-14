import { test, expect, type Page } from '@playwright/test';

async function signIn(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Keycloak으로 로그인' }).click();
  await expect(page.getByRole('heading', { name: '테스트 Keycloak 로그인' })).toBeVisible();
  await page.getByLabel('사용자 이름').fill(username);
  await page.getByLabel('비밀번호').fill('fixture-password');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByRole('heading', { name: '대시보드', exact: true })).toBeVisible();
}

test('PKCE login, admin menus, user/group permissions, MCP registration and member isolation', async ({
  page,
  browser,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '관리 콘솔에 로그인' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/login.png', fullPage: true });
  await signIn(page, 'admin');
  await page.screenshot({ path: 'artifacts/dashboard.png', fullPage: true });
  await page.getByRole('button', { name: '사용자', exact: true }).click();
  await page.getByRole('button', { name: '사용자 등록', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Keycloak 사용자 ID').fill('alice');
  await dialog.getByLabel('표시 이름', { exact: true }).fill('Alice');
  await dialog.getByLabel('이메일', { exact: true }).fill('alice@example.test');
  await dialog.getByRole('button', { name: '사용자 연결', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('사용자를 연결했습니다');
  await page.getByRole('button', { name: '그룹', exact: true }).click();
  await page.getByRole('button', { name: '그룹 만들기', exact: true }).first().click();
  await dialog.getByLabel('그룹 이름', { exact: true }).fill('플랫폼 팀');
  await dialog.getByLabel('설명', { exact: true }).fill('내부 도구를 사용하는 개발팀');
  await dialog.getByRole('checkbox', { name: /Alice/ }).check();
  await dialog.getByRole('button', { name: '그룹 만들기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '플랫폼 팀', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '권한 설정', exact: true }).click();
  await dialog.getByLabel('alpha 접근 권한', { exact: true }).selectOption('allow');
  await dialog.getByRole('button', { name: '권한 저장', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('접근 권한을 저장했습니다');
  await page.screenshot({ path: 'artifacts/groups.png', fullPage: true });
  const memberContext = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' });
  const member = await memberContext.newPage();
  await signIn(member, 'alice');
  await expect(member.getByRole('button', { name: '사용자', exact: true })).toHaveCount(0);
  await expect(member.getByRole('button', { name: '그룹', exact: true })).toHaveCount(0);
  await member
    .getByRole('navigation')
    .getByRole('button', { name: /MCP 서버/ })
    .click();
  await expect(
    member.getByRole('cell', { name: 'alpha 설정 파일에서 관리하는 MCP 서버' }),
  ).toBeVisible();
  await expect(member.getByText('beta', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '사용자', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: 'Alice' })
    .getByRole('button', { name: '권한 관리' })
    .click();
  await dialog.getByLabel('alpha 접근 권한', { exact: true }).selectOption('deny');
  await dialog.getByRole('button', { name: '권한 저장', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await member.getByRole('button', { name: '새로 고침', exact: true }).click();
  await expect(member.getByRole('heading', { name: '표시할 MCP 서버가 없습니다' })).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /MCP 서버/ })
    .click();
  await page.getByRole('button', { name: 'MCP 서버 추가', exact: true }).click();
  const fixture = await (await request.get('/test-fixture')).json();
  await dialog.getByLabel('서버 이름', { exact: true }).fill('팀 지식 검색');
  await dialog.getByLabel('서버 ID').fill('knowledge');
  await dialog.getByLabel('설명', { exact: true }).fill('외부 MCP 문서 검색 연결');
  await dialog.getByLabel('MCP 서버 URL', { exact: true }).fill(fixture.externalUrl);
  await dialog.getByLabel('인증 방식', { exact: true }).selectOption('apiKey');
  await dialog.getByLabel('등록된 자격 증명').selectOption('UI_EXTERNAL_KEY');
  await dialog.getByRole('button', { name: '연결 확인 및 등록', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('cell', { name: '팀 지식 검색 외부 MCP 문서 검색 연결' }),
  ).toBeVisible();
  await page.screenshot({ path: 'artifacts/servers.png', fullPage: true });
  await page.getByRole('button', { name: '감사 기록', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'MCP 서버 등록', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '대시보드', exact: true }).click();
  await expect(page.getByRole('status')).not.toBeVisible({ timeout: 7000 });
  await page.screenshot({ path: 'artifacts/dashboard-populated.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: '대시보드', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('heading', { name: '관리 콘솔에 로그인' })).toBeVisible();
  await memberContext.close();
  expect(errors).toEqual([]);
});
