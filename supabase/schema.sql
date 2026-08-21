-- ============================================================
-- 氨基酸闯关学园 · Supabase 建表与增量同步函数
-- 使用方法：Supabase 控制台 → SQL Editor → 粘贴本文件全部内容 → Run
-- ============================================================

-- 1) 建表：每个学员一行（id 即学号绑定的 userId）
create table if not exists public.learning_records (
  id           text primary key,
  name         text not null default '同学',
  device_ids   text[] not null default '{}',
  practice     int  not null default 0,
  pass1        int  not null default 0,
  pass2        int  not null default 0,
  correct3     int  not null default 0,
  click        int  not null default 0,
  practice_time bigint not null default 0,
  best_correct int  not null default 0,
  total_wrong  int  not null default 0,
  wrong_fx     int  not null default 0,
  wrong_su     int  not null default 0,
  wrong_jx     int  not null default 0,
  wrong_zx     int  not null default 0,
  wrong_fqx    int  not null default 0,
  history_rate jsonb not null default '[]'::jsonb,
  applied_ops  jsonb not null default '{}'::jsonb,
  updated_at   bigint not null default 0,
  created_at   bigint not null default 0
);

-- 2) 行级安全：学习数据无敏感信息，允许 anon key 公开读写
alter table public.learning_records enable row level security;
drop policy if exists "public_all" on public.learning_records;
create policy "public_all" on public.learning_records
  for all using (true) with check (true);

-- 3) 增量同步 RPC 函数：原子累加 + opId 幂等去重（保证多端同时操作不丢数、不重复）
create or replace function public.sync_ops(
  p_id text,
  p_name text,
  p_device text,
  p_ops jsonb
) returns jsonb
language plpgsql
as $$
declare
  o jsonb;
  oid text;
  f text;
  op text;
  val numeric;
  k text;
  i int;
  n int;
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  -- 确保行存在
  insert into public.learning_records(id, name, created_at, updated_at)
  values (p_id, p_name, now_ms, now_ms)
  on conflict(id) do update set name = excluded.name
    where public.learning_records.name = '同学';

  -- 记录设备
  if p_device is not null and p_device <> '' then
    update public.learning_records
      set device_ids = (select array_agg(distinct e) from unnest(device_ids || array[p_device]) e)
      where id = p_id;
  end if;

  -- 逐 op 处理
  n := jsonb_array_length(coalesce(p_ops, '[]'::jsonb));
  for i in 0 .. n - 1 loop
    o := p_ops -> i;
    oid := o->>'opId';
    f := o->>'field';
    op := o->>'op';
    val := coalesce((o->>'value')::numeric, 0);
    k := o->>'key';

    if oid is null then continue; end if;

    -- opId 幂等去重
    if exists(select 1 from public.learning_records where id = p_id and applied_ops ? oid) then
      continue;
    end if;
    update public.learning_records set applied_ops = applied_ops || jsonb_build_object(oid, true) where id = p_id;

    -- 应用增量
    if f = 'practice' then
      update public.learning_records set practice = practice + val where id = p_id;
    elsif f = 'pass1' then
      update public.learning_records set pass1 = pass1 + val where id = p_id;
    elsif f = 'pass2' then
      update public.learning_records set pass2 = pass2 + val where id = p_id;
    elsif f = 'correct3' then
      update public.learning_records set correct3 = correct3 + val where id = p_id;
    elsif f = 'click' then
      update public.learning_records set click = click + val where id = p_id;
    elsif f = 'practiceTime' then
      update public.learning_records set practice_time = practice_time + val where id = p_id;
    elsif f = 'totalWrong' then
      update public.learning_records set total_wrong = total_wrong + val where id = p_id;
    elsif f = 'bestCorrect' then
      update public.learning_records set best_correct = greatest(best_correct, val) where id = p_id;
    elsif f = 'wrongCount' and k is not null then
      if k = 'fx' then update public.learning_records set wrong_fx = wrong_fx + val where id = p_id;
      elsif k = 'su' then update public.learning_records set wrong_su = wrong_su + val where id = p_id;
      elsif k = 'jx' then update public.learning_records set wrong_jx = wrong_jx + val where id = p_id;
      elsif k = 'zx' then update public.learning_records set wrong_zx = wrong_zx + val where id = p_id;
      elsif k = 'fqx' then update public.learning_records set wrong_fqx = wrong_fqx + val where id = p_id;
      end if;
    elsif f = 'historyRate' and op = 'push' then
      update public.learning_records
        set history_rate = history_rate || jsonb_build_object('id', oid, 'rate', val, 't', now_ms)
        where id = p_id
          and not exists (
            select 1 from jsonb_array_elements(history_rate) h where h->>'id' = oid
          );
    end if;
  end loop;

  update public.learning_records set updated_at = now_ms where id = p_id;

  return (select to_jsonb(r) from public.learning_records r where r.id = p_id);
end;
$$;

-- 4) 重命名 RPC
create or replace function public.rename_user(p_id text, p_name text)
returns jsonb language plpgsql as $$
begin
  update public.learning_records set name = p_name, updated_at = (extract(epoch from now())*1000)::bigint
    where id = p_id;
  return (select to_jsonb(r) from public.learning_records r where r.id = p_id);
end;
$$;

-- 5) 启用实时订阅（Realtime），前端据此实时刷新数据档案
-- 关键：开启 replica identity full，UPDATE 事件才会推送完整行（否则只推主键，前端收不到更新后的数据）
alter table public.learning_records replica identity full;
-- add table 需幂等（PostgreSQL 的 alter publication add table 没有 if not exists，用 DO block 检查）
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'learning_records'
  ) then
    alter publication supabase_realtime add table public.learning_records;
  end if;
end $$;

-- 6) 字段迁移（幂等）：为已存在的表补充新增列（如练习时长 practice_time）
--    每次新增字段后，在此追加一行即可；重跑整个文件即可完成升级
alter table public.learning_records add column if not exists practice_time bigint not null default 0;
