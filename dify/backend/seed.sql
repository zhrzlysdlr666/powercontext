-- 600076 赛题：赛博说书人（CyberStory）业务库
-- 库：studystory（首次连接时由 backend 自动 CREATE DATABASE）
-- 表：角色设定 / 梗库 / 道具库 / 历史回合（后四张都在 seekdb 里，Dify 元数据库不动）
-- 全文索引使用 ik 分词器；若目标实例没有 ik，backend 会自动退化成默认分词器并记录在 /health。

DROP TABLE IF EXISTS personas;
CREATE TABLE personas (
  id          VARCHAR(32)  PRIMARY KEY,
  name        VARCHAR(64)  NOT NULL,
  role        VARCHAR(64)  NOT NULL,
  traits      TEXT         NOT NULL,
  catchphrase VARCHAR(200) NOT NULL
) DEFAULT CHARSET = utf8mb4;

DROP TABLE IF EXISTS memes;
CREATE TABLE memes (
  id    VARCHAR(32)  PRIMARY KEY,
  title VARCHAR(80)  NOT NULL,
  tag   VARCHAR(40)  NOT NULL,
  body  TEXT         NOT NULL
) DEFAULT CHARSET = utf8mb4;

DROP TABLE IF EXISTS props;
CREATE TABLE props (
  id     VARCHAR(32)  PRIMARY KEY,
  name   VARCHAR(80)  NOT NULL,
  effect TEXT         NOT NULL
) DEFAULT CHARSET = utf8mb4;

DROP TABLE IF EXISTS turns;
CREATE TABLE turns (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(64)  NOT NULL,
  input      VARCHAR(300) NOT NULL,
  hits       TEXT         NOT NULL,
  context    TEXT         NOT NULL,
  answer     TEXT         NULL,
  created_at DATETIME     NOT NULL
) DEFAULT CHARSET = utf8mb4;

CREATE FULLTEXT INDEX ft_personas_traits ON personas (traits) WITH PARSER ik;
CREATE FULLTEXT INDEX ft_memes_body      ON memes (body)      WITH PARSER ik;
CREATE FULLTEXT INDEX ft_memes_title     ON memes (title)     WITH PARSER ik;
CREATE FULLTEXT INDEX ft_props_effect    ON props (effect)    WITH PARSER ik;

-- 角色设定（12 条）
INSERT INTO personas (id, name, role, traits, catchphrase) VALUES
('P01', '老周', '退休的机房管理员', '守着一屋子老旧服务器，说话三句不离断电重启，遇到故障先泡茶', '先别慌，插头拔了再插一次'),
('P02', '阿蓝', '凌晨三点的产品经理', '需求文档写得比小说长，喜欢用「很简单」开头，随时能改方案', '这个需求很简单，明天上线'),
('P03', '小满', '刚入职的算法实习生', '模型调不动就先怀疑数据，笔记本上贴满便利贴', 'loss 不降，一定是数据脏了'),
('P04', '铁柱', '外包运维大哥', '随身带一捆网线，信奉物理接触能治百病，口头禅是先摸摸机箱', '机房静电大，先把鞋脱了'),
('P05', '柳工', '写了二十年 SQL 的老 DBA', '执行计划不看三遍不落笔，最恨 select 星号', '你这 SQL，全表扫描了吧'),
('P06', '小唐', '爱写段子的测试工程师', '把每个 bug 都编成顺口溜，缺陷单里夹带私货', '这不是 bug，这是特性'),
('P07', '吴教授', '研究检索系统的导师', '讲课时爱拿图书馆举例，喜欢在黑板上画倒排表', '先把倒排表画出来，再说优化'),
('P08', '阿凯', '健身教练转型的前端', '代码写得像训练计划，讲究组数和休息，周末只谈深蹲', '再来一组，页面就渲染完了'),
('P09', '花姐', '行政兼团建策划', '掌握全公司的零食库存，能用一顿火锅解决跨部门矛盾', '先吃火锅，方案边吃边聊'),
('P10', '老赵', '保安队长', '认得每个人的工牌，凌晨巡楼时顺手帮人关显示器', '工牌没戴，先登记一下'),
('P11', '小鹿', '画原画的视觉设计师', '配色卡永远比需求多，坚持圆角比尖角温柔', '这个圆角再大两像素'),
('P12', '陈总', '只出现在周会上的老板', '语速极快，喜欢说赋能和闭环，散会前一定加一句再想想', '我们要形成闭环，赋能业务');

-- 梗库（18 条）
INSERT INTO memes (id, title, tag, body) VALUES
('M01', '凌晨上线的仪式感', '加班', '每次大版本上线都要点一份小龙虾，好像吃了就能压住回滚的冲动，结果往往是边吃边回滚。'),
('M02', '这个需求很简单', '需求', '凡是开头说很简单四个字的需求，后面一定跟着三张流程图和一句「就改一点点」。'),
('M03', '测试环境是好的', '甩锅', '本地跑得飞快，测试环境一切正常，一到生产就报错，仿佛三个环境住着三个不同的人。'),
('M04', '重启大法', '运维', '遇到任何故障，先重启，重启不好就重装，重装不好就换机器，最后发现是网线松了。'),
('M05', '全表扫描的浪漫', '数据库', '不加索引的查询跑起来像在机房里翻箱倒柜，慢是慢了点，但每个字节都被认真看过。'),
('M06', 'Cookie 掉了', '登录', '上周还能免登录，这周突然让你重新登录，说明你的会话比你本人先下班了。'),
('M07', '周会闭环', '职场', '会上说要形成闭环，会后就没人再提，唯一闭环的是会议纪要的转发链路。'),
('M08', '弹窗广告关不掉', '产品', '关闭按钮只有三像素，你以为点中了，其实只是给它点了个赞。'),
('M09', '实习生改了一行', '实习生', '实习生说只改了一行代码，diff 里出现了四百行，其中三百八十行是重新格式化。'),
('M10', '需求文档第十版', '需求', '文件名叫需求文档_最终版_真的最终版_最终确认版，打开发现里面只有一句话：待补充。'),
('M11', '值班电话响', '值班', '值班最怕凌晨的电话，铃声一响，脑子里已经把离职信写完了一半。'),
('M12', '文档比代码新', '文档', '代码三个月没动，文档昨天刚更新，说明有人在用想象力维护这个项目。'),
('M13', '三点的产品经理', '加班', '凌晨三点最活跃的不是服务器，是产品经理，思路清晰得让人怀疑他白天在装睡。'),
('M14', '招聘写着抗压', '职场', '招聘要求里写抗压能力强，意思是要能扛住不合理的排期还能笑着说没问题。'),
('M15', '滚动发布心跳', '发布', '发布进度条走到百分之九十九的时候，整个团队的心跳都会同步一次。'),
('M16', '兜底方案', '方案', '每个方案后面都要跟一个兜底方案，兜底方案的后面还有一个兜底方案，最后兜底的是熬夜。'),
('M17', '一根网线的玄学', '运维', '网线水晶头压得漂亮，链路就稳；压得难看，包就丢。这是个玄学问题，没人敢反驳。'),
('M18', '检索不到就是没有', '检索', '用户搜不到，就说系统里没有；其实是分词把关键词切碎了，倒排表里根本没这个词。');

-- 道具库（10 条）
INSERT INTO props (id, name, effect) VALUES
('G01', '保温杯', '装枸杞热水，喝一口能多扛两个小时的会议'),
('G02', '机械键盘', '敲击声极大，用声音证明自己在努力工作'),
('G03', '一捆网线', '物理连接万物的信仰道具，机房开光必备'),
('G04', '便利贴', '贴在显示器边缘，把待办事项变成墙上的装饰'),
('G05', '降噪耳机', '戴上即进入结界，外界需求暂时无法穿透'),
('G06', '工牌', '进出办公区的通行证，也是保安队长老赵的执法依据'),
('G07', '一箱速溶咖啡', '凌晨续命物资，苦到能让人重新读一遍需求'),
('G08', '白板笔', '画架构图专用，一擦就没，适合反复推翻方案'),
('G09', '旧机械硬盘', '装着十年前的数据，插上还能听到时代的轰鸣'),
('G10', '小风扇', '对着机箱吹，据说是给服务器降火的传统仪式');
