---
name: office-document-reader
description: 读取并理解 Word DOCX、Excel XLSX、PowerPoint PPTX 文件，将内容导入个人知识库并保留工作表、幻灯片等来源定位。
---

# Office 文档阅读

当用户希望读取、总结、检索或导入 Word、Excel、PowerPoint 文件时使用本技能。

- 用户明确选择文件后，通过知识库的 Office 导入入口读取文件。
- DOCX 保留标题、段落、列表与表格；XLSX 按工作表输出；PPTX 按幻灯片输出并包含演讲者备注。
- 只处理用户明确上传的文件，不读取其他本机目录。
- 原件保存在受控文档目录，解析结果写入知识库并参与检索。
- 遇到旧版 DOC、XLS、PPT 时，请用户先另存为 DOCX、XLSX、PPTX。
