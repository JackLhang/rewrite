// 2025-10-24 03:22:31
// 2026-11-11 追加：删除「无门槛红包」条幅（feedType=10023 + templateName=hongbao）
//   新增开关 removeHongbao（默认 true）；命中条件三选一：
//     1) feedContent.templateName === "hongbao"
//     2) feedContent.data 里出现 "hongbaoType" / "hongbaoEventTitle"（模板名改了也能认）
//     3) feedContent.data 里出现 "hongbaotipbase" / "zuihuimai/static/s11"（红包素材目录）
//   普通文章（feedType=10000）永不删。

(() => {
    if (!$response?.body) return $done({});

    let modified = false;
    let body;

    try {
        body = JSON.parse($response.body);
    } catch (e) {
        console.log(`JSON解析失败: ${e.message}`);
        return $done({});
    }

    // 获取参数值
    const removeAllBanners = $argument?.removeAllBanners !== undefined ? $argument.removeAllBanners : true;
    const removePinnedArticles = $argument?.removePinnedArticles !== undefined ? $argument.removePinnedArticles : true;
    const removeHongbao = $argument?.removeHongbao !== undefined ? $argument.removeHongbao : true;

    // 移除全部横幅
    const removeAllBannersFunc = () => {
        if (!removeAllBanners) return;

        if (Array.isArray(body?.data?.list)) {
            const originalLength = body.data.list.length;
            body.data.list = body.data.list.filter(item =>
                item.feedType !== 10002
            );
            modified ||= (originalLength !== body.data.list.length);
        }
    };

    // 移除置顶文章
    const removePinnedArticlesFunc = () => {
        if (!removePinnedArticles) return;

        if (Array.isArray(body?.data?.list)) {
            const originalLength = body.data.list.length;
            body.data.list = body.data.list.filter(item =>
                item.feedType !== 10003
            );
            modified ||= (originalLength !== body.data.list.length);
        }
    };

    // 移除横幅广告
    const removeBannerAdsFunc = () => {
        if (!Array.isArray(body?.data?.list)) return;

        body.data.list.forEach(item => {
            if (item.feedContent?.focusNewsData && Array.isArray(item.feedContent.focusNewsData)) {
                const originalLength = item.feedContent.focusNewsData.length;
                item.feedContent.focusNewsData = item.feedContent.focusNewsData.filter(ad =>
                    !ad.isAd
                );
                modified ||= (originalLength !== item.feedContent.focusNewsData.length);
            }
        });
    };

    // 移除信息流广告（flag===2 或 feedType===10004，或 smallTags 中有 text==="广告"）
    const removeFeedAdsFunc = () => {
        if (!Array.isArray(body?.data?.list)) return;

        const originalLength = body.data.list.length;
        body.data.list = body.data.list.filter(item => {

            if (item.feedContent?.flag === 2 || item.feedType === 10004) {
                return false;
            }

            if (item.feedContent?.smallTags && Array.isArray(item.feedContent.smallTags)) {
                const hasAdTag = item.feedContent.smallTags.some(tag =>
                    typeof tag.text === 'string' && tag.text === '广告'
                );
                if (hasAdTag) {
                    return false;
                }
            }

            return true;
        });

        modified ||= (originalLength !== body.data.list.length);
    };

    // 移除「无门槛红包」条幅（京东/天猫 11.11 那种整条横幅）
    const removeHongbaoFunc = () => {
        if (!removeHongbao) return;
        if (!Array.isArray(body?.data?.list)) return;

        const originalLength = body.data.list.length;
        body.data.list = body.data.list.filter(item => {
            if (item.feedType === 10000) return true;          // 普通文章永不删

            const fc = item.feedContent;
            if (!fc || typeof fc !== 'object') return true;

            if (typeof fc.templateName === 'string' && fc.templateName === 'hongbao') return false;

            const d = typeof fc.data === 'string' ? fc.data : '';
            if (d && /"hongbaoType"|"hongbaoEventTitle"|hongbaotipbase|zuihuimai\/static\/s11/.test(d)) return false;

            return true;
        });

        const removed = originalLength - body.data.list.length;
        if (removed > 0) console.log(`IT之家：删除无门槛红包条幅 ${removed} 条`);
        modified ||= (removed > 0);
    };

    // 执行所有过滤函数
    removeAllBannersFunc();
    removePinnedArticlesFunc();
    removeBannerAdsFunc();
    removeFeedAdsFunc();
    removeHongbaoFunc();

    // 仅在修改时重新序列化
    $done(modified ? {
        body: JSON.stringify(body),
    } : {});
})();
