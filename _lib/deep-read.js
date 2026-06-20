// ============================================================================
// api/_lib/deep-read.js  —  THEISI AI deep-read prompt builder
// v1.0 · 2026-06-20 · Task 4 (Session 33)
// ----------------------------------------------------------------------------
// Builds the live-AI deep-read PROMPT from the engine's resolved facts + the
// §8 canonical terminology. The model NARRATES these facts — it never computes,
// never recasts a score, never invents a number/target/date. The engine output
// is authority; words vary, meaning and caveat are fixed.
//
// Lives in _lib/ (leading underscore) so Vercel does NOT route it as a function
// — zero added to the 12-function count. Imported by api/sa-analyze.js.
// ============================================================================

// §8 CANONICAL TERMINOLOGY — verbatim from THEISI_SCORER_EXPLAINER_LOGIC_SPEC §8.
// Single source: the tab and this file MUST carry identical strings.
const TERMS = {
  archetype: {
    momentum_trap: { label:'فخ الزخم', hint:'قوي سعرياً، ضعيف جوهرياً',
      full:'السهم صاعد بقوة بسبب الزخم، بس جودة الشركة ضعيفة — يعني حركة سعر، مو بالضرورة عمل قوي. أقرب لفرصة تداول من استثمار طويل.' },
    momentum_trap_growth_bet: { label:'فخ الزخم · رهان نمو', hint:'هامش ضعيف، نمو صاعد',
      full:'الهامش ضعيف الحين لكن النمو والتقديرات صاعدة — يمكن الشركة ببداية مرحلة نمو، مو شركة سيئة. رهان على النمو، راقب التنفيذ.' },
    value_trap: { label:'فخ القيمة', hint:'رخيص لسبب',
      full:'السهم يبدو رخيص، بس النمو والتقديرات تتراجع — الرخص هنا تحذير، مو فرصة. رخيص لأن في خلل، مو لأنه مقيّم غلط.' },
    quality_premium: { label:'علاوة الجودة', hint:'ممتاز بس غالي',
      full:'شركة من الطراز الأول، بس سعرها مرتفع ونموها بطيء — تدفع مقابل الأمان والاستقرار، مو مقابل صعود سريع. أفضل دخول لو تراجع المضاعف.' },
    hidden_quality_extended_candidate: { label:'قوي لكن ممتد', hint:'ممتاز بس مرتفع بسرعة',
      full:'شركة قوية بكل الدرجات، بس ركضت بسرعة وارتفعت كثير — الدخول الحين غير مناسب. درجة القصير المنخفضة توقيت، مو ضعف. انتظر تصحيح.' },
    hidden_quality_out_of_favor: { label:'جودة مهملة', hint:'قوي بس خارج الاهتمام',
      full:'شركة قوية الجودة بس السوق مو مهتم فيها حالياً — يعني عمل جيد ومُهمَل، مو سهم ضعيف. الزخم بارد، لكن الأساس سليم.' },
    hidden_quality: { label:'جودة قوية', hint:'ربحية قوية، بلا ساق ضعيفة',
      full:'شركة قوية الجودة بس السوق مو مهتم فيها حالياً — يعني عمل جيد ومُهمَل، مو سهم ضعيف. الزخم بارد، لكن الأساس سليم.' },
    unconfirmed: { label:'غير مؤكد', hint:'يبدو قوي بس غير موثّق',
      full:'الدرجات تبدو قوية، بس مبنية على شي يبدو لمرة وحدة (مثل ربح غير متكرر) مو على أرباح مستمرة — تعامل مع القوة بحذر لين تثبت.' },
    'null': { label:'إشارات متوازنة', hint:'ما في نمط حاد',
      full:'ما في نمط واحد مهيمن — لا فخ ولا علاوة ولا توقيت خاص. اقرأ الدرجات مباشرة وقرّر حسب أهدافك.' }
  },
  grade: {
    V:{ label:'التقييم' }, G:{ label:'النمو' }, P:{ label:'الربحية' },
    M:{ label:'الزخم' }, R:{ label:'مراجعات الأرباح' }
  },
  conviction: {
    high:{ label:'راسخ', full:'التصنيف ثابت من فترة طويلة وتغطية واسعة — رأي مستقر، مو إشارة جديدة.' },
    medium:{ label:'عادي', full:'تغطية وثبات معقولين — ثقة عادية.' },
    provisional:{ label:'غير مؤكد بعد', full:'التصنيف جديد أو التغطية قليلة — يبدو قوي بس ما تأكد بعد، تعامل بحذر.' }
  },
  flag: {
    distortion:{ label:'بند لمرة واحدة', full:'الدرجة مبنية على شي يبدو لمرة وحدة (مثل ربح غير متكرر) مو على أرباح مستمرة — تعامل مع الدرجة العالية بحذر لين تثبت.' }
  }
};

const _arNum = n => String(n).replace(/[0-9]/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
const _bindKey = name => ({Valuation:'V',Growth:'G',Profitability:'P',Momentum:'M','EPS Revisions':'R'})[name];

// resolve archetype + branch -> the §8 term key (mirrors the tab's archKey)
function archKey(o){
  const a = o.archetype;
  if (a == null) return 'null';
  const f = (o.flags||[]).find(x => x.type===a && x.branch);
  if (a==='momentum_trap' && f && f.branch==='growth_bet') return 'momentum_trap_growth_bet';
  if (a==='hidden_quality' && f){
    if (f.branch==='extended_candidate') return 'hidden_quality_extended_candidate';
    if (f.branch==='out_of_favor') return 'hidden_quality_out_of_favor';
  }
  return a;
}

// derive §5.7 personal context from the real store; OMIT any clause whose data
// is missing (never guess). `allRecs` = store.stocks ∪ store.etfs.
function buildPersonalContext(sym, rec, allRecs){
  const parts = [];
  const me = allRecs.find(r => (r.symbol||r.sym)===sym) || {};
  const D = (me.sheets && me.sheets.dashboard) || {};
  const H = (me.sheets && me.sheets.holdings) || {};
  const owned = rec.owned;

  const w = H['Weight'];
  if (owned && w != null && !isNaN(Number(w))) {
    const pct = Number(w)*100;
    parts.push(`وزن المركز في محفظتك ${ pct>=1 ? _arNum(pct.toFixed(1)) : _arNum(pct.toFixed(2)) }٪`);
  } else if (!owned) {
    parts.push('لا تملكه («جديد»، مرشّح تنويع)');
  }

  const sector = (D['Sector']||'').trim();
  if (sector) {
    const sectorOf = r => (((r.sheets&&r.sheets.dashboard)||{})['Sector']||'').trim();
    const ownedSame = allRecs.filter(r => {
      const h = (r.sheets&&r.sheets.holdings)||{}; const sh = Number(h['Shares']||0);
      return sh>0 && sectorOf(r)===sector && (r.symbol||r.sym)!==sym;
    }).map(r => r.symbol||r.sym);
    if (ownedSame.length > 0) {
      const sample = ownedSame.slice(0,3).join('، ');
      const more = ownedSame.length>3 ? ` و${_arNum(ownedSame.length-3)} غيرها` : '';
      parts.push(`أنت متركّز في قطاع ${sector} (تملك ${sample}${more} بنفس القطاع — أي زيادة هنا تزيد تركيزك القطاعي)`);
    }
    // no overlap -> omit the concentration clause entirely (don't claim "not concentrated")
  }

  parts.push('وأنت في الإمارات بلا ضريبة أرباح، فحجم المركز قرار تخصيص بحت');
  return parts.join('، ') + '.';
}

// build the deep-read prompt from engine facts only.
function buildDeepReadPrompt(sym, o, allRecs){
  const L=o.long, M=o.mid, S=o.short;
  const ak = archKey(L), at = TERMS.archetype[ak];
  const conv = L.conviction ? TERMS.conviction[L.conviction.tier] : null;
  const gradesBlock = ['V','G','P','M','R'].map(k => `  ${TERMS.grade[k].label} (${k}): ${o.grades[k] || 'غير مصنّف'}`).join('\n');
  const flagsList = (L.flags||[]).map(f => f.type).join(', ') || 'لا يوجد';
  const distorted = (L.flags||[]).some(f => f.type==='distortion');
  const isNull = L.archetype === null;
  const bind = L.bindingConstraint
    ? `${TERMS.grade[_bindKey(L.bindingConstraint.grade)].label} ${L.bindingConstraint.label} — يتحسّن لو ارتفعت`
    : 'بلا نقطة ضعف — كل الدرجات قوية';
  const ctx = buildPersonalContext(sym, o, allRecs);

  return `أنت تشرح قراءة سهم واحد لمستثمر إماراتي (لا ضريبة أرباح رأسمالية). اكتب بالعربية الخليجية الودّية — كأنك صديق ذكي يشرح، مو تقرير بنكي رسمي. ممنوع الفصحى المتكلّفة.

⚠️ قواعد صارمة لا تُكسر:
- المحرّك (الكود) حسب هذه الأرقام والتصنيفات. أنت تشرحها فقط. ممنوع تخترع أي رقم، أو سعر مستهدف، أو نسبة. ممنوع تقول "اشترِ" أو "بِع".
- الأرقام (٠–١٠٠) هي قراءات ترتيبية لكل أفق — مو نسب مئوية، ولا عوائد، ولا احتمالات. تقدر تعيد ذكر الرقم («الطويل ٦٢») لكن ممنوع منعاً باتاً تحوّل معناه: لا «٦٢٪ فرصة»، ولا «عائد ٦٢»، ولا «احتمال ٦٢٪». أعد ذكر الرقم، لا تعِد تفسير ما يقيسه.
- لو كلامك ناقض أي تصنيف أو علامة أدناه — فالتصنيف هو الصح، عدّل كلامك. الدرجات تفوز دائماً.
- الكلمات تتغيّر، المعنى والتنبيه ثابتان: اكتب نوع الموقف بكلماتك الخليجية الطازجة المرتبطة بدرجات هذا السهم تحديداً — لا تكرّر الجملة المعرّفة حرفياً. لكن غيّر الصياغة فقط، لا المعنى ولا التنبيه. مثال: تقدر تصيغ «فخ الزخم» بكلمات جديدة، لكن ممنوع تقرّر إنه شي إيجابي أو تتجاهل تنبيهه.
- استخدم أسماء المصطلحات كما هي (نوع الموقف، الثقة، الدرجات، النقطة المقيِّدة) — هي موحّدة عبر النظام كله.
- كل قراءة اتجاهية بهامش خطأ واسع — وضّح هذا، وما هي توصية.

الحقائق (من المحرّك — هذه مصدرك الوحيد):
السهم: ${sym}${o.owned?' — تملكه':' — لا تملكه («جديد»، مرشّح تنويع)'}
الكوانت (Quant، مقياس ١–٥): ${o.quant ?? 'غير متوفر'}

الدرجات (كل درجة نسبية لقطاع السهم — قُلها هكذا، مو مطلقة):
${gradesBlock}

الآفاق الثلاثة (٠–١٠٠، قراءات ترتيبية):
  قصير (توقيت الدخول، الرقم الوحيد المحسوب): ${S.score ?? 'غير مقيَّم'}
  متوسط (إعادة التسعير): ${M.score ?? 'غير مقيَّم'}
  طويل (الاحتفاظ): ${L.score ?? 'غير مقيَّم'}

نوع الموقف (Archetype): «${at.label}» — ${at.hint}
  المعنى الذي يجب أن توصله (بكلماتك، لا حرفياً): ${at.full}
${isNull?'  (هذا سهم «إشارات متوازنة» — لا نمط حاد. اشرح الدرجات مباشرة، وقدّمه كوضوح صادق لا كنقص. محايد، مو سلبي.)':''}

الثقة (Conviction): ${conv?conv.label:'—'}${L.conviction?` (${L.conviction.days!=null?L.conviction.days+' يوم على التصنيف':''}${L.conviction.analysts!=null?'، '+L.conviction.analysts+' محلل':''})`:''}
  معناها (بكلماتك): ${conv?conv.full:''}
العلامات (Flags): ${flagsList}
${distorted?'تنبيه «بند لمرة واحدة» (وصّل معناه بكلماتك، لا تتجاوزه): '+TERMS.flag.distortion.full:''}
النقطة المقيِّدة: ${bind}

السياق الشخصي (مشتق من محفظتك): ${ctx}

اكتب شرحاً من ٧ أجزاء قصيرة (جملة-جملتين لكل جزء)، بهذا الترتيب:
١) القراءات الثلاث (قصير/متوسط/طويل) — كل واحدة من درجاتها.
٢) نوع الموقف «${at.label}» — اشرح يعني إيش بالضبط لـ ${sym} بكلماتك، مرتبطاً بدرجاته الفعلية أعلاه.
٣) الكوانت + الدرجات الخمس كما هي.
٤) الثقة (راسخ/عادي/غير مؤكد بعد) مع المدة وعدد المحللين.
٥) لو في تنبيه «بند لمرة واحدة» — وصّل معناه. (إن ما فيه، تجاوز هذا الجزء.)
٦) النقطة المقيِّدة + إيش تراقب. ⚠️ ما تراقبه لازم يكون درجة (مثل: «راقب لو تحسّنت الربحية في النتائج الجاية») أو حدث نوعي — ممنوع منعاً باتاً تخترع رقماً أو هدفاً أو تاريخاً (مثل «راقب إيرادات فوق ٨٠ مليون» ممنوعة). درجة أو حدث فقط، بلا أرقام مخترعة.
٧) السياق الشخصي كما هو أعلاه (حجم المركز، التركيز إن وُجد، لا ضريبة في الإمارات).
اختم بسطر تنبيه: قراءة اتجاهية بهامش خطأ واسع، ليست نصيحة. القرار قرارك.`;
}

module.exports = { buildDeepReadPrompt, buildPersonalContext, archKey, TERMS };
