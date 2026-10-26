"""QA E2E test: Python Playwright + installed Chromium. Only requires Python Playwright on QA machine."""
import json, os, subprocess, time, sys, requests
from pathlib import Path
from playwright.sync_api import sync_playwright

project=Path(__file__).resolve().parents[1]
proc=subprocess.Popen(['node',str(project/'qa/browser-fixture.mjs')], cwd=project, stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
checks=[]
errors=[]
def check(name,expr):
    checks.append((name,bool(expr)))
    print(('PASS' if expr else 'FAIL'),name,flush=True)

def finish():
    proc.terminate()
    try: proc.wait(timeout=4)
    except subprocess.TimeoutExpired: proc.kill()
try:
    fixture=json.loads(proc.stdout.readline())
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
        session=requests.Session()
        # Environment blocks localhost in the graphical browser. Proxy requests via Python
        # while retaining the real browser rendering and JavaScript execution.
        def proxy(route):
            request=route.request
            if request.url.endswith('/events'):
                route.fulfill(status=204,body='')  # SSE can't be streamed via Playwright route.fulfill
                return
            kwargs={'allow_redirects':False,'timeout':10}
            if request.post_data is not None: kwargs['data']=request.post_data.encode('utf-8')
            headers={k:v for k,v in request.headers.items() if k.lower() not in ('host','content-length','accept-encoding')}
            kwargs['headers']=headers
            try:
                r=session.request(request.method,request.url,**kwargs)
                res_headers={k:v for k,v in r.headers.items() if k.lower() not in ('content-encoding','transfer-encoding','connection','content-length')}
                route.fulfill(status=r.status_code,body=r.content,headers=res_headers)
            except Exception as ex:
                print('proxy error',ex,file=sys.stderr)
                route.abort()
        for w in [320,360,390,414,768,1024,1280,1920]:
            ctx=browser.new_context(viewport={'width':w,'height':800})
            page=ctx.new_page()
            page.route('**/*',proxy)
            page.on('pageerror',lambda err: errors.append(str(err)))
            page.goto(fixture['base']+'/?token='+fixture['token'])
            page.wait_for_selector('#agent-select option')
            check(f'ширина {w}: нет горизонтальной прокрутки',page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'))
            if w==390:
                check('телефон: вкладки закреплены снизу',page.evaluate("getComputedStyle(document.querySelector('#tabs')).position==='fixed'"))
                check('телефон: элементы управления видимы',page.locator('#run-form button[type=submit]').is_visible())
                page.select_option('#agent-select','file-helper')
                page.fill('#task','допиши строку в привет.txt')
                page.locator('#run-form button[type=submit]').click()
                page.locator('.approval').wait_for(timeout=12000)
                check('появился запрос подтверждения',page.locator('.approval').count()==1)
                page.locator('.approval .btn').first.click()
                page.wait_for_function("document.querySelector('#run-status')?.textContent.includes('Готово')",timeout=12000)
                check('задача выполнена', (Path(fixture['workspace'])/'привет.txt').read_text().endswith('Эту строку дописал демонстрационный агент.\n'))
                page.locator('[data-tab=models]').click()
                check('вкладка моделей открывается',page.locator('#models-grid .card').count()>=1)
                page.locator('#theme-toggle').click()
                page.reload()
                check('тема сохраняется',page.evaluate("getComputedStyle(document.body).backgroundColor")=='rgb(18, 18, 18)')
                page.screenshot(path='/mnt/data/prorab-work/mobile-390.png',full_page=True)
            if w==1280: page.screenshot(path='/mnt/data/prorab-work/desktop-1280.png',full_page=True)
            ctx.close()
        browser.close()
    check('без ошибок JavaScript в браузере',not errors)
except Exception as ex:
    print('E2E ERROR',str(ex),file=sys.stderr)
    checks.append(('E2E execution',False))
finally:finish()
print(json.dumps({'passed':sum(ok for _,ok in checks),'total':len(checks),'errors':errors},ensure_ascii=False))
sys.exit(0 if all(ok for _,ok in checks) else 1)
