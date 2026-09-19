package com.dabbar.smshelper

import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** Premium دبّر Quick Settings tile: opens text quick-entry without an intermediate screen. */
class DabbarQuickTileService : TileService() {
    private fun quickIntent(): Intent = Intent(
        Intent.ACTION_VIEW,
        Uri.parse("https://www.dabbar.online/app/dabbar-dashboard-full.html?quick=text")
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

    override fun onStartListening() {
        super.onStartListening()
        qsTile?.apply {
            label = getString(R.string.tile_label)
            icon = Icon.createWithResource(this@DabbarQuickTileService, R.drawable.ic_dabbar_tile)
            state = Tile.STATE_ACTIVE
            updateTile()
        }
    }

    override fun onClick() {
        super.onClick()
        val intent = quickIntent()
        val pending = PendingIntent.getActivity(
            this,
            4101,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        unlockAndRun {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startActivityAndCollapse(pending)
            } else {
                startActivityAndCollapse(intent)
            }
        }
    }
}
