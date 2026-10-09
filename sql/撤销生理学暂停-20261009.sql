-- ============================================================================
--  撤销「生理学暂停」· 恢复原机制    ·  2026-10-09
--  ---------------------------------------------------------------------------
--  【用户决定】2026-10-09 07:47：
--    「干脆继续保留原来的机制吧，避免后续再反复修改」
--    → 生理学·人可研梦滚动复习**不再暂停**，回到v1.42.0 之前的行为：
--      43 行常驻 tasks 表，卡片正常显示、正常打卡、正常计时。
--
--  【为什么撤销是对的（实测数据支撑）】
--    本项目的**不是增量同步，而是整表 upsert**：
--      setLocal(key, value) → pushToSupabase(key, value)
--      → upsertRows(table, 整张表)   ← 每次写任何一行，都推整张 tasks 表
--    所以「省流量」的唯一变量是**表的总行数**，与「哪一行变没变」无关。
--    实测 tasks 表单行约 527 字节：
--      · 清理重复行后 520 行 → 每次写任务推 268 KB
--      · 其中生理学 43 行  =   22 KB
--    → **生理学只占 8%**。为省这 8% 而引入
--      「轻量表 + 跨设备暂停标记 + 守卫链前移 + 搬回SQL + 迁移脚本」
--      这 6 处复杂度，代价与收益完全不成比例。
--
--  【当前数据状态（执行本脚本前已实测，2026-10-09 07:50）】
--      tasks.physio_rolling            = 43 行
--      rolling_reviews_paused          = 43 行
--      两边 id 完全相同（43/43 命中），day_num 无重复
--      两边进度一致（已完成 0，专注合计22 秒）
--    → 迁移的「复制」段其实**已经成功了**，只是最后的删除段没执行，
--      于是同一份数据在两张表里各存一份。**没有任何数据损失或冲突。**
--    → 因此本脚本只需要：**确保 tasks 里的 43 行完整**（必要时从paused 回补）
--      +删除暂停标记，让前端重新接管。**不需要搬回任何数据。**
--
--  【执行方式】Supabase 后台 → SQL Editor → 按顺序分段执行
--  【幂等】是，可重复执行
-- ============================================================================


-- ============================================================================
-- 第 1 段 · 体检（只读，先看数）
-- ============================================================================

-- 1a. tasks 里生理学是否完整（期望 43 行、day_label 覆盖 DAY 1-43）
select count(*)                                            as "tasks 内生理学行数（期望 43）",
       count(distinct substring(day_label from '\d+'))     as "覆盖的不同 DAY（期望 43）",
       count(*) filter (where done)                        as "已完成",
       coalesce(sum(total_focus_sec), 0)                   as "专注秒数合计"
from public.tasks
where source = 'physio_rolling';

-- 1b. 若上面少于 43 行，从 paused 表回补（下面的语句**按需执行**，见第 3 段说明）
--     正常情况下**不需要**执行——tasks 里那 43 行是完整的。


-- ============================================================================
-- 第 2 段 · 确保 tasks 里 43 行完整（按需回补，平时可跳过）
-- ----------------------------------------------------------------------------
--  ⚠️ 只有第 1 段查出「行数 < 43」时才需要跑这一段。
--     保持注释态；需要时把下面 4 行前面的「--」去掉再执行。
-- ⚠️ on conflict (id) do nothing 保证幂等：paused 里有、tasks 里也有的行不会重复插。
-- ============================================================================
-- insert into public.tasks
--   (id, user_id, title, done, date, category, slot, block, subject, task_type,
--    estimated_min, remind_on_estimate, total_focus_sec, status, time_record_ids,
--    source, day_label, note, rr_note, created_at)
-- select p.id, p.user_id, p.title, p.done, '' as date, 'general', null, null,
--        'xizong', 'review', null, true, p.total_focus_sec, 'todo', '{}',
--        'physio_rolling', p.day_label, p.note, p.rr_note, now()
-- from public.rolling_reviews_paused p
-- where p.source = 'physio_rolling'
--   and not exists (select 1 from public.tasks t where t.id = p.id);


-- ============================================================================
-- 第 3 段 · 取消「暂停」标记（★ 必须执行，幂等）
-- ----------------------------------------------------------------------------
--  这个标记是「暂停」能自我维持的关键：前端 autoImportPhysioPlan 的守卫链
--  最前面会判它，判为「已暂停」就不导入并把卡片降级成说明块。
--  不清这个标记 → 生理学卡会**一直**显示「已暂停 · 机制与数据完整保留」，
--  即使 43 行数据都在，也点不了「开始 / 完成此DAY」。
--
-- ⚠️⚠️ 两个实测坑（2026-10-09 用户执行时报错后修正）：
--
-- 【坑1】data 列是 **text**，不是 jsonb！
--   schema.sql:227 定义为 `data text not null`（存 xk.v2 的 JSON 快照）。
--   所以 `data->>'v'` 会报
--     ERROR: 42883: operator does not exist: text ->> unknown
--   → 本段必须用 `::jsonb` 显式转型后才能用 ->>（见下方回读）。
--   ⚠️ 这条对 **Store.getShared/setShared 的前端代码同样成立**：
--      那两个方法读 koujue_state 时是 `JSON.parse(row.data)`（纯 JS 解析），
--      不涉及 SQL 运算符，**所以前端一直是对的**，只有 SQL 侧写错了。
--
-- 【坑2】UPDATE 不会凭空创建这一行！
--   实测 2026-10-09：该 scope 的行**根本不存在**（迁移第 6 段从未成功执行），
--   `update ... where scope=...` 匹配 0 行 → 标记等于没清。
--   → 必须用 **insert ... on conflict do update**（upsert），
--     这样「行不存在」也能写入一行 v="" 的「明确未暂停」状态。
--
-- 【坑3】koujue_state 只有 select/insert/update 策略、**没有 delete**，
--   所以这里用「把值改成空串」取消暂停，而不是 delete 行（与 v1.42.1 的约定一致）。
-- ============================================================================
insert into public.koujue_state (scope, data, updated_at)
values ('physio_rolling_paused', '{"v":"","at":"2026-10-09"}', now())
on conflict (scope) do update
  set data      = excluded.data,
      updated_at = excluded.updated_at;

-- 回读：应返回 1 行、data 里 v 为空串（注意 data 是 text，要 ::jsonb 才能 ->>）
select scope, data, data::jsonb->>'v' as "v（应为空串）"
from public.koujue_state
where scope = 'physio_rolling_paused';


-- ============================================================================
-- 第 4 段 · 回读校验
-- ============================================================================

-- 4a. tasks 里生理学应完整（期望 43 / 43）
select count(*)                                         as "tasks 内行数（期望 43）",
       count(distinct substring(day_label from '\d+'))  as "不同 DAY（期望 43）"
from public.tasks
where source = 'physio_rolling';

-- 4b. 暂停标记已取消。**必须恰好 1 行**，且 data::jsonb->>'v' 必须是空串（不是 "1"）
--     ⚠️ 若这里返回 0 行 → 说明第 3 段没执行成功，请单独重跑第 3 段
select count(*)                                    as "标记行数（应为 1）",
       max(data::jsonb->>'v')                      as "v（应为空串）",
       max((data::jsonb->>'v') = '1')              as "是否仍标记为已暂停（应为 false）"
from public.koujue_state
where scope = 'physio_rolling_paused';

-- 4c. ⚠️ 前端本机可能还残留 localStorage 标记（需在浏览器控制台手动清，见文末）
--     云端标记已清后，刷新页面若仍显示「已暂停」，就是本机localStorage 没清

-- 4d. 顺带看一眼 tasks 总量（配合 sql/清理tasks重复行-20261009.sql 使用）
select count(*) as "tasks 总行数" from public.tasks;


-- ============================================================================
-- 第 5 段 · 可选：清理已无用的轻量表
-- ----------------------------------------------------------------------------
--  ⚠️ **建议先别删**。留着它零成本（43 行、几十 KB，且不在 SYNC_TABLES 里、
--     前端从不读它，所以**不产生任何流量**）。
--     它的唯一价值是「万一 tasks 那 43 行出问题时的数据备份」——
--     等你确认生理学一切正常一个月后，再执行这一行：
-- ============================================================================
-- drop table if exists public.rolling_reviews_paused;


-- ============================================================================
-- 【本脚本之后还要做什么】
--   1. 每台设备浏览器控制台执行一次（清掉本机残留的暂停标记）：
--        localStorage.removeItem('xizong_physio_paused')
--      ——注意：前端读到「未暂停」时也会自动清，但手动执行更保险。
--   2. 强刷 Ctrl+F5，让 v1.42.6 的前端（已移除暂停降级逻辑）生效。
--   3. 到「任务」页看生理学卡：应显示「独立进度 · 有空随时参加」，
--      下方有「开始 / 完成此DAY」按钮，**不再是「已暂停」说明块**。
-- ============================================================================
