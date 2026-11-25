## מה באמת קרה

ב-09:51 שעון מקומי מפתח דחף ל-repo של ה-GitOps commit של "סדר וניקיון": **`pricing-api: migrate values to chart v3 schema`**. הוא העלה את ה-chart של Helm מ-2.7.4 ל-3.0.1 ושכתב את ה-values "לפי ה-example values של v3". בהודעת ה-commit נכתב *no functional change intended*. בפועל הוא שינה שלושה דברים שהיו חשובים:

1. **ה-memory limit ירד מ-1536Mi ל-768Mi** (וה-requests מ-1Gi ל-512Mi, ה-CPU מ-2/500m ל-1/250m), העתק מה-example values של ה-chart. ב-`javaOpts` עדיין היה כתוב **`-Xmx1g`**, כלומר ה-JVM קיבל רשות ל-heap גדול יותר מכל ה-container שלו.
2. **ה-label `app=pricing-api` נעלם.** chart v2 לקח labels נוספים מ-`extraPodLabels`; chart v3 קורא את `podLabels` ומוסיף בעצמו את ה-labels הסטנדרטיים `app.kubernetes.io/*`. המיגרציה שמרה את `tier: backend` והפילה את `app: pricing-api`. ה-selector של ה-Deployment עצמו משתמש ב-`app.kubernetes.io/*`, אז ה-rollout עבר חלק. אבל ה-**Service** הוא manifest נפרד, והוא עדיין בוחר `app=pricing-api,tier=backend`.
3. **הגדרות ה-probes נבלעו בשקט.** הבלוק הישן `probes:` הוא מפתח של chart v2. chart v3 קורא `livenessProbe:` / `readinessProbe:`, אז נכנסו ערכי ברירת המחדל של ה-chart: liveness אחרי 30 שניות, kill אחרי בערך שלושה כישלונות, במקום 120 שניות.

commit אחד, root cause אחד. כל השאר היו עדים.

## ציר זמן

| UTC | מקומי (UTC+2) | אירוע |
|---|---|---|
| 03:12 | 05:12 | `fluent-bit` נהרג ב-OOM על k2m9 (ה-limit של 200Mi שלו עצמו; לא קשור) |
| 05:31 | 07:31 | `ci-runner` פונה (evicted) על w3zx בגלל **ephemeral-storage** (לא קשור) |
| 07:21 | 09:21 | Helm rev 13: annotations של Prometheus (לא מזיק) |
| 07:33 | 09:33 | דיפלוי של inventory-api 2.8.1 (לא קשור) |
| 07:51:12 | 09:51:12 | **ה-commit של מיגרציית ה-values נדחף** |
| 07:51:58 | 09:51:58 | Flux מחיל אותו (`HelmRelease/shop/pricing-api configured`) |
| 07:52:29 | 09:52:29 | **Helm rev 14** מתחיל; ה-rolling update יוצא לדרך |
| 07:55:36 | 09:55:36 | ה-pod הישן האחרון יורד. **ל-Service אין endpoints**: כל בקשת מחיר מקבלת 503 |
| 07:56:48 | 09:56:48 | **ה-OOM kill הראשון: `pricing-api-6d5b8c7f9-m5rjc`** |
| 08:03:12 | 10:03:12 | ה-HPA עולה מ-4 ל-8 |
| 08:10:02 | 10:10:02 | ה-on-call מעלה את `maxReplicas` ל-12 (rev 15, "נכשל" על `--wait`) |
| 08:10:31 | 10:10:31 | ה-HPA עולה מ-8 ל-12 |
| 08:11:40 | 10:11:40 | **k2m9 מדווח MemoryPressure** |
| 08:11:52 | 10:11:52 | **`recs-feature-sync-6f7d9c8b4-hv2lp` מפונה** |
| 08:14 עד 08:35 | 10:14 עד 10:35 | עושים cordon ל-k2m9 ואחר כך uncordon (בלי שום השפעה) |
| 08:17 עד 08:31 | 10:17 עד 10:31 | ה-HPA מתנדנד: 12, 7, 12, 9 |
| 08:20:14 | 10:20:14 | `search-indexer-0` נהרג ב-OOM על w3zx (ה-limit של 3Gi שלו עצמו; לא קשור) |
| 08:39:50 | 10:39:50 | commit התיקון: ה-resources הישנים, ה-label `app` חוזר, ה-probes תחת המפתחות הנכונים |
| 08:41:58 | 10:41:58 | ה-pod המתוקן הראשון Ready, ה-endpoints חוזרים, ה-503 נעצרים |

השבתה: **46 דקות**. 50 OOM kills, 47 liveness kills, 97 restarts על פני 17 pods.

## איך שינוי אחד יצר חמישה סימפטומים

- **pods ב-OOMKilled.** `-Xmx1g` בתוך container של 768Mi. ה-JVM טוען price book של 1.2 מיליון SKUs, ואז ה-delta refresh הראשון דוחף את ה-process מעבר ל-limit של ה-cgroup. ה-kernel הורג אותו (exit 137) לפני ש-Java מספיקה לזרוק `OutOfMemoryError`, אז הלוג של ה-container פשוט נקטע.
- **Liveness kills.** על node עמוס, ה-warmup של ה-JVM לקח יותר זמן מחלון ה-liveness של ברירת המחדל, וה-kubelet הרג containers (exit 143) שהיו מסתדרים 30 שניות אחר כך. ב-`RESTARTS` ה-restarts האלה נראים בדיוק כמו ה-OOM.
- **Service בלי endpoints.** pods ששרדו את ה-warmup היו Ready, אבל כבר לא נשאו `app=pricing-api`. selector שתופס אפס pods הוא לא שגיאה, רק אובייקט Endpoints ריק. הלוג של האפליקציה אפילו אומר `quote requests last 60s: 0`.
- **HPA שלא מצליח להחליט.** חצי מה-CPU request הכפיל את *אחוז הניצול* עבור אותו CPU, אז ה-HPA עלה. כשאף pod לא היה Ready לא היו לו מטריקות (`FailedGetResourceMetric`), ועם חצי מה-pods ב-restart בכל רגע הוא התנדנד בין 7 ל-12.
- **node תחת לחץ, וקורבן תמים.** ה-scheduler משבץ לפי *requests* (512Mi כל אחד). חמישה JVMs של pricing שצרכו בפועל עד 768Mi נחתו על k2m9 לצד job סנכרון שצרך 1.8 GiB מול request של 256Mi. כשהזיכרון הפנוי ירד מתחת ל-500Mi, ה-kubelet פינה את ה-pod שהכי חרג מה-request שלו: `recs-feature-sync` של הצוות השני.

## למה ההטעיות היו שגויות

- **"k2m9 הוא node דפוק."** ה-OOM של הבוקר המוקדם היה fluent-bit שהגיע ל-limit של עצמו, חמש שעות קודם. pods של pricing נהרגו ב-OOM על שלושת ה-nodes, וה-cordon ל-k2m9 לא שינה כלום.
- **"memory leak ב-4.12.3."** ה-tag של ה-image היה זהה ב-revisions 12, 13, 14 ו-16. אותו image רץ בלי בעיה אחרי התיקון.
- **"הדיפלוי של inventory."** שירות אחר, 20 דקות קודם, בלי תלות ב-pricing.
- **"Helm שבור."** rev 15 נכשל כי `helm --wait` אף פעם לא ראה Deployment זמין. סימפטום של ההשבתה, לא סיבה.
- **"metrics-server שבור."** HPAs אחרים קראו מטריקות כרגיל. ה-HPA של pricing הגיב ל-requests שירדו בחצי ול-pods שלא היו Ready.
- **"readiness gate תקוע."** ה-pods *היו* Ready. ה-Service פשוט לא בחר בהם.
- **"בעיית זיכרון בכל הקלאסטר."** ל-`search-indexer-0` יש limit משלו של 3Gi, והוא נהרג ב-OOM מדי פעם בזמן reindex.

## תיקונים

**מיידי:** להחזיר את ערכי הזיכרון וה-CPU, להחזיר את ה-label `app: pricing-api` תחת `podLabels`, ולהעביר את הגדרות ה-probes ל-`livenessProbe` / `readinessProbe`. בדיוק מה שעשה commit התיקון.

**מבני**
- **diff לפלט המרונדר, לא ל-values.** להריץ `helm diff upgrade` / `flux diff` ב-CI על כל שינוי ב-HelmRelease, ולדרוש reviewer שני כשמשתנים limits, labels או probes.
- **לגזור את ה-JVM מה-container.** להחליף את `-Xmx` ב-`-XX:MaxRAMPercentage=75` כדי שה-heap ילך אחרי ה-limit, ולקבוע limits לפי שיא צריכה שנמדד.
- **להחזיק את ה-Service ליד ה-pods שהוא בוחר.** לשחרר את ה-Service בתוך ה-chart (או באותו kustomization), עם selector על אותם labels כמו ה-Deployment.
- **alert על endpoints ריקים.** `kube_endpoint_address_available == 0` לכל Service שעומד מאחורי ingress מקפיץ pager תוך שניות, לא דקות.
- **ולידציה ל-values.** ה-chart v3 צריך לבוא עם `values.schema.json` עם `additionalProperties: false`, כך שמפתח לא מוכר כמו `probes` או `extraPodLabels` יכשיל את ה-upgrade במקום להיבלע.
- **startup probes לאפליקציות שעולות לאט.** `startupProbe` נותן ל-JVM זמן להתחמם בלי להחליש את ה-liveness probe.
- **requests שמשקפים את המציאות.** בשירותים קריטיים לקבוע memory requests ששווים ל-limits, כדי שה-scheduler לא יוכל לעשות overcommit ל-node.
- **canary לשינויי GitOps.** rollout שמחכה להצלחה של traffic אמיתי (לא רק Ready) היה נעצר כבר ב-pod הראשון.

## האירוע האמיתי: Reddit, 14 במרץ 2023 ("יום הפאי")

Reddit שדרגו את אחד מקלאסטרי ה-Kubernetes שלהם מ-1.23 ל-1.24. הגרסה הזו החליפה את ה-label `node-role.kubernetes.io/master` ב-`control-plane`. ה-route reflectors של Calico אצלם הוגדרו עם node selector על ה-label הישן, אז אחרי השדרוג אף route reflector לא נבחר, תקשורת ה-pods התפרקה והאתר היה למטה כ-**314 דקות**. בסוף הצוות שחזר את הקלאסטר מגיבוי. שום דבר לא קרס עם שגיאה ברורה; selector פשוט הפסיק בשקט לתפוס משהו.

קראו את הכתבה שלהם: **"You Broke Reddit: The Pi-Day Outage"** ב-r/RedditEng.

## מה לקחת לעבודה האמיתית

1. **שינוי אחד, הרבה סימפטומים.** כשחמישה דברים נשברים ביחד, חפשו את השינוי האחד שמשותף להם לפני שרודפים אחרי כל אחד בנפרד.
2. **"No functional change" זו טענה, לא עובדה.** refactor של קונפיגורציה הוא דיפלוי. תעשו diff למה שמרונדר ומוחל בפועל.
3. **selectors נכשלים בשקט.** שינוי שם של label אף פעם לא זורק שגיאה; הוא פשוט לא תופס כלום. תגדירו alert על endpoints ריקים ותחזיקו selectors ואת מה שהם בוחרים באותו מקום.
4. **restart הוא לא דבר אחד.** OOM kills (137), liveness kills (143) ו-evictions הם רוצחים שונים עם תיקונים שונים. ספרו אותם בנפרד.
5. **requests קובעים את השיבוץ, הצריכה קובעת את ה-eviction.** כשהם לא מסכימים, ה-pod של מישהו אחר משלם.
