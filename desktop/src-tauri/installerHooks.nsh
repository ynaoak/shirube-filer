; shirube-filer NSIS インストーラフック（Windows 直接配布版）
;
; アンインストール時に、ユーザーデータ（設定ディレクトリ・WebView の localStorage 等）を
; 任意で削除する。インタラクティブなアンインストール時のみ確認ダイアログを出し、
; サイレント（/S）実行時は誤削除防止のため何もしない。
;
; 注意: クラウド連携の認証情報は OS の資格情報ストア（Windows 資格情報マネージャー）に
;       保存されており、ここでは削除されない。完全に消すにはアプリ内の
;       「設定 → インポート・エクスポート → すべてのデータを削除」を使用すること。

!macro NSIS_HOOK_PREUNINSTALL
  ; サイレント実行時は確認できないためユーザーデータは残す
  IfSilent shirube_skip_userdata

  MessageBox MB_YESNO|MB_ICONQUESTION "shirube-filer の設定・保存データも削除しますか？$\n$\n（クラウド連携の認証情報は OS の資格情報マネージャーに残ります。完全に削除するには、アンインストール前にアプリ内の「すべてのデータを削除」をご利用ください。）" IDNO shirube_skip_userdata

    ; 独自の設定ディレクトリ（%APPDATA%\shirube-filer）
    RMDir /r "$APPDATA\shirube-filer"
    ; Tauri / WebView2 のアプリデータ（identifier 配下・localStorage 等）
    RMDir /r "$LOCALAPPDATA\com.shirube-filer"
    RMDir /r "$APPDATA\com.shirube-filer"

  shirube_skip_userdata:
!macroend
