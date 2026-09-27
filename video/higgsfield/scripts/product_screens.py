"""Build the missing demo screens over the Home screenshot (home.png, 2000x1182; convert
../references/home-current.webp to PNG and place it beside the generated HTML)."""
import pathlib
F=str(pathlib.Path(__file__).resolve().parents[3] / "packages/ui/assets/fonts")
CSS=f"""
@font-face{{font-family:Karma;src:url(file://{F}/Karma-Medium.ttf);font-weight:500}}
@font-face{{font-family:Geist;src:url(file://{F}/Geist-Variable.woff2)}}
*{{box-sizing:border-box;margin:0}}
body{{width:2000px;height:1182px;position:relative;overflow:hidden;background:url(home.png) 0 0/2000px 1182px no-repeat;font-family:Geist;color:#29231f}}
.title{{position:absolute;left:860px;top:66px;width:276px;height:42px;background:linear-gradient(90deg,#8d362f,#88332d);color:#fff;font:500 21px Karma;display:flex;align-items:center;justify-content:center}}
.panel{{position:absolute;left:282px;top:128px;width:1690px;height:1054px;background:#faf8f4;border-top-left-radius:14px;padding:40px 44px}}
.serif{{font-family:Karma;font-weight:500}}
h1{{font:500 34px Karma;margin:10px 0 6px}}
.muted{{color:#7b7b76}}
.chip{{display:inline-block;padding:5px 12px;border-radius:9px;font-size:18px}}
.card{{background:#f1ebe4;border-radius:12px;padding:22px 26px}}
.opt{{background:#fffefa;border:1.5px solid #e7e6df;border-radius:14px;padding:20px 24px;font-size:22px;display:flex;align-items:center;gap:18px;margin-top:14px}}
.letter{{width:38px;height:38px;border-radius:50%;border:1.5px solid #d6d3cb;display:flex;align-items:center;justify-content:center;font-size:18px;color:#4f4a40;flex:none}}
.btn{{display:inline-block;background:#c5050c;color:#fff;border-radius:999px;padding:13px 26px;font-size:19px}}
.src{{display:flex;gap:14px;align-items:flex-start;padding:14px 0;border-top:1px solid #e7e6df;font-size:18px;line-height:1.35}}
.src:first-of-type{{border-top:0}}
.ic{{width:22px;height:26px;border:2px solid #7b7b76;border-radius:4px;flex:none;margin-top:2px}}
.bar{{height:6px;border-radius:3px;background:#e7e6df;width:420px;margin-top:10px}} .bar i{{display:block;height:6px;border-radius:3px;background:#c5050c;width:60%}}
"""
SVG_DOC='<svg class="ic2" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7b7b76" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>'
def src(t,s): return f'<div class="src">{SVG_DOC}<div><div>{t}</div><div class="muted" style="font-size:16px">{s}</div></div></div>'
SOURCES=f'''<div class="card" style="background:#fffefa;border:1.5px solid #e7e6df">
<div class="serif" style="font-size:24px;margin-bottom:8px">Built from your PHILOS 101 sources</div>
{src("Module 3 slides","Necessary and Sufficient Conditions")}
{src("Rosenberg reading","Argument forms · Exam Prep")}
{src("Module quiz","Necessary and Sufficient Conditions · Tue, Sep 29")}</div>'''
HEAD='''<span class="chip" style="background:#cfe89a">PHILOS 101</span> <span class="muted" style="font-size:18px;margin-left:6px">In-class Exam I · Practice test</span>
<h1>Practice test: Necessary and Sufficient Conditions</h1>'''
OPTS=[("A","Necessary, but not sufficient"),("B","Sufficient, but not necessary"),("C","Both necessary and sufficient"),("D","Neither necessary nor sufficient")]
def question(state):
    o=""
    for L,t in OPTS:
        if state=="correct" and L=="B":
            o+=f'<div class="opt" style="background:#eef3fa;border-color:#7894b4"><div class="letter" style="border-color:#7894b4;color:#516378">{L}</div><div style="flex:1">{t}</div><span class="chip" style="background:#dfe8f5;color:#516378;font-size:17px">✓ Correct</span></div>'
        else:
            o+=f'<div class="opt"><div class="letter">{L}</div>{t}</div>'
    fb=""
    if state=="correct":
        fb='''<div class="card" style="background:#eef3fa;margin-top:18px;font-size:19px;line-height:1.5;color:#29231f">Every square is a rectangle, so being a square guarantees it. That makes it <b style="font-weight:600">sufficient</b>. But a rectangle doesn't have to be a square, so it isn't <b style="font-weight:600">necessary</b>.<div class="muted" style="font-size:16px;margin-top:6px">From Module 3 slides</div></div>'''
    btn = "Next question →" if state=="correct" else "Check answer"
    return f'''<div class="muted" style="font-size:18px">Question 3 of 5</div><div class="bar"><i></i></div>
<div class="card" style="margin-top:26px;background:#fffefa;border:1.5px solid #e7e6df;padding:30px 32px">
<div class="serif" style="font-size:28px;line-height:1.35">Being a square is a ______ condition for being a rectangle.</div>{o}{fb}
<div style="text-align:right;margin-top:22px"><span class="btn">{btn}</span></div></div>'''
def loading():
    return '''<div class="card" style="margin-top:26px;background:#fffefa;border:1.5px solid #e7e6df;height:640px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px">
<svg width="54" height="54" viewBox="0 0 50 50"><circle cx="25" cy="25" r="20" fill="none" stroke="#f1ebe4" stroke-width="5"/><path d="M25 5a20 20 0 0 1 20 20" fill="none" stroke="#c5050c" stroke-width="5" stroke-linecap="round"/></svg>
<div class="serif" style="font-size:30px">Building your practice test…</div><div class="muted" style="font-size:19px">Reading 3 PHILOS 101 sources</div></div>'''
def practice(inner):
    return f'''<div class="title">Study &amp; Learn</div><div class="panel">{HEAD}
<div style="display:flex;gap:36px;margin-top:22px"><div style="flex:1.9">{inner}</div><div style="flex:1;margin-top:0">{SOURCES}</div></div></div>'''
def policy():
    rules=[("Your instructor decides","There's no single campus AI rule. Each instructor sets expectations for their own course, so check the syllabus and Canvas, and ask when unsure."),
           ("Unapproved use is misconduct","Using AI in ways your instructor hasn't allowed can count as unauthorized materials under UWS 14."),
           ("Cite it when asked","If your instructor requires it, document and cite AI use following UW Libraries guidance."),
           ("Think before you paste","Text you put into AI tools may not stay private.")]
    L="".join(f'<div class="card" style="margin-top:14px"><div class="serif" style="font-size:23px">{t}</div><div style="font-size:18.5px;line-height:1.45;margin-top:4px;color:#4f4a40">{d}</div></div>' for t,d in rules)
    ok=lambda t:f'<div style="display:flex;gap:14px;font-size:19px;padding:11px 0"><b style="color:#516378">✓</b>{t}</div>'
    no=lambda t:f'<div style="display:flex;gap:14px;font-size:19px;padding:11px 0"><b style="color:#c5050c">✕</b>{t}</div>'
    R=f'''<div class="card" style="background:#e9e1fd;margin-top:14px;padding:26px 28px"><div class="serif" style="font-size:25px;margin-bottom:8px">How Wiz helps in COMPSCI 400</div>
{ok("Explains concepts and points you to course sources")}{ok("Builds practice questions from your class materials")}{ok("Helps you plan and study")}
{no("Won't write code or answers you submit for a grade")}{no("Won't submit, post or enroll for you")}</div>'''
    return f'''<div class="title">COMPSCI 400</div><div class="panel">
<span class="chip" style="background:#f6d9da">COMPSCI 400</span> <span class="muted" style="font-size:18px;margin-left:6px">Programming III</span>
<h1>AI policy</h1><div class="muted" style="font-size:19px">What's allowed with AI in this course, and how Wiz follows it.</div>
<div style="display:flex;gap:36px;margin-top:14px"><div style="flex:1.35">{L}</div><div style="flex:1">{R}</div></div>
<div class="muted" style="font-size:16px;margin-top:26px">Source: UW–Madison Office of Student Conduct and Community Standards · conduct.students.wisc.edu</div></div>'''
def voice():
    bars="".join(f'<i style="display:block;width:5px;height:{h}px;border-radius:3px;background:#c5050c"></i>' for h in [10,22,34,18,28,12,24])
    mic='<svg width="22" height="22" viewBox="0 0 24 24" fill="#c5050c" stroke="#c5050c" stroke-width="1.6" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3" fill="none"/></svg>'
    return f'''<div style="position:absolute;left:1082px;top:1116px;width:104px;height:58px;background:#faf8f4"></div>
<div style="position:absolute;left:968px;top:1118px;width:330px;height:54px;border-radius:999px;background:#fffefa;border:1.5px solid #f0c9c9;box-shadow:0 0 0 6px rgba(197,5,12,.12),0 6px 18px rgba(197,5,12,.18);display:flex;align-items:center;gap:14px;padding:0 20px">
{mic}<div style="display:flex;align-items:center;gap:4px">{bars}</div><span class="muted" style="font-size:18px">Listening…</span></div>'''
pages=dict(p1_generating=practice(loading()),p2_question=practice(question("q")),p3_correct=practice(question("correct")),a_policy=policy(),l3_listening=voice())
for n,b in pages.items():
    pathlib.Path(n+".html").write_text(f"<html><head><style>{CSS}</style></head><body>{b}</body></html>")
