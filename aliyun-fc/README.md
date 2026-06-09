# 阿里云函数计算 API

这个函数负责两件事：

- 给前端生成 OSS 表单直传签名。
- 把作品 JSON 保存到 OSS 的 `projects/` 目录。

函数环境变量：

```txt
ALIYUN_ACCESS_KEY_ID=你的 AccessKey ID
ALIYUN_ACCESS_KEY_SECRET=你的 AccessKey Secret
OSS_BUCKET=jiyiyuzhou
OSS_ENDPOINT=oss-cn-guangzhou.aliyuncs.com
OSS_PUBLIC_DOMAIN=https://jiyiyuzhou.oss-cn-guangzhou.aliyuncs.com
```

OSS 跨域规则建议：

```txt
来源：https://jiyiyuzhou.top
允许 Methods：GET、POST、PUT
允许 Headers：*
暴露 Headers：ETag
```

函数计算 HTTP 触发器需要允许匿名访问，并开启 CORS。

请求处理程序：

```txt
index.handler
```
