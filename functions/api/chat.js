// Cloudflare Functions - /api/chat

export async function onRequestPost(context) {
  const { request, env } = context;
  
  try {
    const body = await request.json();
    const { action } = body;
    
    // CORS設定
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    };
    
    // アクションに応じて処理を分岐
    switch (action) {
      case 'analyze':
        return await analyzeReceipts(body, env, corsHeaders);
      
      case 'suggestFolder':
        return await suggestFolderNames(body, env, corsHeaders);
      
      case 'saveToFolder':
        return await saveToFolder(body, env, corsHeaders);
      
      case 'getFolders':
        return await getFolders(env, corsHeaders);
      
      case 'addFolder':
        return await addFolder(body, env, corsHeaders);
      
      case 'search':
        return await performSearch(body, env, corsHeaders);
      
      default:
        return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
          headers: corsHeaders,
          status: 400
        });
    }
  } catch (error) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message 
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500
    });
  }
}

// OPTIONSリクエスト対応
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

// 画像解析（レシート認識）
async function analyzeReceipts(body, env, corsHeaders) {
  const { images } = body;
  
  if (!images || images.length === 0) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: '画像が指定されていません' 
    }), { headers: corsHeaders });
  }
  
  try {
    const receipts = [];
    
    for (const imageData of images) {
      // Base64からバイナリに変換
      const base64Data = imageData.split(',')[1];
      const mimeType = imageData.split(',')[0].split(':')[1].split(';')[0];
      
      // Gemini APIを呼び出し
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${env.CAESAR_ANALYSIS}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                {
                  text: `この画像に含まれるすべてのレシート情報を抽出してください。
複数のレシートがある場合は、それぞれを「---RECEIPT---」という区切り文字で分けてください。

各レシートについて以下の情報を抽出してください：
- 店名
- 日付
- 合計金額
- 商品リスト（商品名と価格）

フォーマット：
店名: [店名]
日付: [日付]
合計金額: [金額]
商品:
- [商品名] [価格]
- [商品名] [価格]
...`
                },
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Data
                  }
                }
              ]
            }]
          })
        }
      );
      
      const result = await response.json();
      
      if (result.candidates && result.candidates[0]) {
        const text = result.candidates[0].content.parts[0].text;
        
        // 複数レシートを分割
        const receiptTexts = text.split('---RECEIPT---').filter(t => t.trim());
        
        receiptTexts.forEach(receiptText => {
          receipts.push({
            id: Date.now() + Math.random(),
            text: receiptText.trim()
          });
        });
      }
    }
    
    return new Response(JSON.stringify({
      success: true,
      receipts: receipts
    }), { headers: corsHeaders });
    
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: '画像解析に失敗しました: ' + error.message
    }), { headers: corsHeaders });
  }
}

// フォルダ名提案
async function suggestFolderNames(body, env, corsHeaders) {
  const { receipts } = body;
  
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${env.CAESAR_FOLDER}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `以下のレシート情報を分析して、適切なフォルダ名を3つ提案してください。
フォルダ名は簡潔で分かりやすく、以下のような形式が望ましいです：
- "2025年5月_スーパー"
- "コンビニ_日用品"
- "外食_2025年5月"

レシート情報:
${receipts.join('\n\n---\n\n')}

フォルダ名候補を3つ、改行区切りで出力してください。説明は不要です。`
            }]
          }]
        })
      }
    );
    
    const result = await response.json();
    
    if (result.candidates && result.candidates[0]) {
      const text = result.candidates[0].content.parts[0].text;
      const suggestions = text.split('\n')
        .map(s => s.trim())
        .filter(s => s && !s.startsWith('-') && !s.startsWith('*'))
        .map(s => s.replace(/^[\d\.]+\s*/, '').replace(/^["']|["']$/g, ''))
        .slice(0, 3);
      
      return new Response(JSON.stringify({
        success: true,
        suggestions: suggestions
      }), { headers: corsHeaders });
    }
    
    return new Response(JSON.stringify({
      success: false,
      error: 'フォルダ名の提案に失敗しました'
    }), { headers: corsHeaders });
    
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: 'フォルダ名提案エラー: ' + error.message
    }), { headers: corsHeaders });
  }
}

// フォルダに保存（GAS呼び出し）
async function saveToFolder(body, env, corsHeaders) {
  const { folderName, receipts, images } = body;
  
  try {
    // GAS Web Appを呼び出し
    const response = await fetch(env.GAS_WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'saveReceipts',
        folderName: folderName,
        receipts: receipts,
        images: images
      })
    });
    
    const result = await response.json();
    
    return new Response(JSON.stringify(result), { headers: corsHeaders });
    
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: '保存に失敗しました: ' + error.message
    }), { headers: corsHeaders });
  }
}

// フォルダ一覧取得
async function getFolders(env, corsHeaders) {
  try {
    const response = await fetch(env.GAS_WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getFolders' })
    });
    
    const result = await response.json();
    
    return new Response(JSON.stringify(result), { headers: corsHeaders });
    
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: 'フォルダ取得に失敗しました: ' + error.message
    }), { headers: corsHeaders });
  }
}

// フォルダ追加
async function addFolder(body, env, corsHeaders) {
  const { folderName } = body;
  
  try {
    const response = await fetch(env.GAS_WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'addFolder',
        folderName: folderName
      })
    });
    
    const result = await response.json();
    
    return new Response(JSON.stringify(result), { headers: corsHeaders });
    
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: 'フォルダ追加に失敗しました: ' + error.message
    }), { headers: corsHeaders });
  }
}

// 検索（CaeSearch）
async function performSearch(body, env, corsHeaders) {
  const { query } = body;
  
  try {
    // まずSpreadsheetからデータを取得
    const dataResponse = await fetch(env.GAS_WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getAllReceipts' })
    });
    
    const dataResult = await dataResponse.json();
    
    if (!dataResult.success) {
      throw new Error('データ取得に失敗しました');
    }
    
    // Gemini APIで検索・回答生成
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${env.CAESAR_SEARCH}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `以下のレシートデータベースを参照して、ユーザーの質問に答えてください。

データベース:
${JSON.stringify(dataResult.data, null, 2)}

質問: ${query}

具体的な数値や日付を含めて、正確に回答してください。`
            }]
          }]
        })
      }
    );
    
    const result = await response.json();
    
    if (result.candidates && result.candidates[0]) {
      const answer = result.candidates[0].content.parts[0].text;
      
      return new Response(JSON.stringify({
        success: true,
        answer: answer
      }), { headers: corsHeaders });
    }
    
    return new Response(JSON.stringify({
      success: false,
      error: '検索結果が見つかりませんでした'
    }), { headers: corsHeaders });
    
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: '検索に失敗しました: ' + error.message
    }), { headers: corsHeaders });
  }
}
