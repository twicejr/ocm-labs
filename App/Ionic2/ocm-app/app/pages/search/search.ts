/// <reference path="../../lib/typings/collections/collections.d.ts" />
import {Component, OnInit, NgZone, ChangeDetectorRef} from '@angular/core';
import {Http} from '@angular/http';
import {NavController, NavParams, Events, Platform, Loading, Modal} from 'ionic-angular';
import {TranslateService, TranslatePipe} from 'ng2-translate/ng2-translate';
import {Keyboard} from 'ionic-native';
import {PlaceSearchResult, GeoLatLng, GeoBounds, POISearchParams, JourneyRoute, JourneyRouteLeg} from '../../core/ocm/model/AppModels';
import {Base, LogLevel} from '../../core/ocm/Base';
import {Utils} from '../../core/ocm/Utils';
import {Mapping, MappingAPI} from '../../core/ocm/mapping/Mapping';
import {AppManager} from '../../core/ocm/services/AppManager';
import {POIManager} from '../../core/ocm/services/POIManager';
import {JourneyManager} from '../../core/ocm/services/JourneyManager';

import {POIDetailsPage} from '../poi-details/poi-details';
import {SettingsPage} from '../settings/settings';
import {SignInPage} from '../signin/signin';
import {PoiDetails} from '../../components/poi-details/poi-details';
import {PlaceSearch} from '../../components/place-search/place-search';
import {RoutePlanner} from '../../components/route-planner/route-planner';

@Component({
    templateUrl: 'build/pages/search/search.html',
    pipes: [TranslatePipe], // add in each component to invoke the transform method
    directives: [PoiDetails, PlaceSearch, RoutePlanner]
})

export class SearchPage extends Base implements OnInit {

    private mapDisplayed: boolean = false;
    private debouncedRefreshResults: any;
    private mapCanvasID: string;

    private initialResultsShown: boolean = false;

    private searchOnDemand: boolean = true;
    selectedPOI: any;
    private poiViewMode: string = "side";
    private searchPolyline: string;
    private routePlanningMode: boolean = true;
    private sideViewAvailable = false;

    constructor(
        private appManager: AppManager,
        private nav: NavController,
        private navParams: NavParams,
        private events: Events,
        private translate: TranslateService,
        private platform: Platform,
        private poiManager: POIManager,
        private mapping: Mapping,
        private journeyManager: JourneyManager,
        private zone: NgZone,
        private changeDetector: ChangeDetectorRef
    ) {
        super();

        //this.mapping = new Mapping(events);

        this.mapCanvasID = "map-canvas";

        //decide whether to use Native Google Maps SDK or Google Web API        
        if ((platform.is("ios") || platform.is("android"))
            && !(this.appManager.isPlatform("core") || this.appManager.isPlatform("mobileweb"))
        ) {
            this.mapping.setMapAPI(MappingAPI.GOOGLE_NATIVE);

            //if using native maps, don't allow the keyboard to scroll the view as this conflicts with the plugin rendering
            Keyboard.disableScroll(true);
        } else {
            this.mapping.setMapAPI(MappingAPI.GOOGLE_WEB);
            //this.mapping.setMapAPI(MappingAPI.LEAFLET);
        }
    }

    ionViewDidEnter() {
        this.log("Entered search page.", LogLevel.VERBOSE);
        //give input focus to native map
        this.mapping.focusMap();
    }

    ionViewWillLeave() {
        //remove input focus from native map
        this.log("Leavings search page.", LogLevel.VERBOSE);
        this.mapping.unfocusMap();
    }

    getPreferredMapHeight(clientHeight: number): number {
        if (clientHeight == null) {
            clientHeight = Utils.getClientHeight();
        }
        var preferredContentHeight = clientHeight - 100;
        return preferredContentHeight;
    }

    enforceMapHeight(size: any) {
        this.log("Would resize map:" + size.width + " " + size.height, LogLevel.VERBOSE);

        this.checkViewportMode();

        let preferredContentHeight = this.getPreferredMapHeight(size[0]);

        if (document.getElementById(this.mapCanvasID).offsetHeight != preferredContentHeight) {
            document.getElementById(this.mapCanvasID).style.height = preferredContentHeight + "px";
        }
        if (this.mapping) {
            this.mapping.updateMapSize();
        }
    }

    checkViewportMode() {
        this.log("Checking viewport mode:" + this.appManager.clientWidth);
        if (this.appManager.clientWidth > 1000) {
            this.sideViewAvailable = true;
        } else {
            this.sideViewAvailable = false;
        }

        if (this.sideViewAvailable && this.poiViewMode != "side") {
            this.poiViewMode = "side"; //switch to side panel view mode for poi details
        }

        if (!this.sideViewAvailable && this.poiViewMode == "side") {
            this.poiViewMode = "modal"; //switch to modal view mode for poi details
        }
    }

    ngOnInit() {

        this.debouncedRefreshResults = Utils.debounce(this.refreshResultsAfterMapChange, 1000, false);

        this.events.subscribe('ocm:poi:selected', (args) => {

            this.viewPOIDetails(args[0]);

        });

        this.events.subscribe('ocm:mapping:ready', () => {
            if (!this.initialResultsShown) {

                //centre map on users location before starting to fetch other info
                //get user position
                //attempt to find user current position

                this.locateUser().then(() => {
                    this.log("Search: maps ready, showing first set of results");


                }, (rejection) => {
                    this.log("Could not locate user..");

                }).catch(() => {
                    this.log("Default search..");
                    this.initialResultsShown = true;
                    this.refreshResultsAfterMapChange();
                });


            }
        });

        this.events.subscribe('ocm:mapping:zoom', () => { this.debouncedRefreshResults(); });
        this.events.subscribe('ocm:mapping:dragend', () => { this.debouncedRefreshResults(); });
        this.events.subscribe('ocm:poiList:updated', (listType) => { this.showPOIListOnMap(listType); });
        this.events.subscribe('ocm:poiList:cleared', () => {
            this.mapping.clearMarkers();
            this.debouncedRefreshResults();
        });

        this.events.subscribe('ocm:window:resized', (size) => {
            //handle window resized event, updating map layout if required
            this.enforceMapHeight(size[0]);
        });

        //switch app to to side view mode if display wide enough
        this.checkViewportMode();

        this.mapping.initMap(this.mapCanvasID);

        //TODO:centre map to inital location (last search pos?)

        var appContext = this;

        //first start up, get fresh core reference data, then we can start getting POI results nearby
        if (!this.appManager.referenceDataManager.referenceDataLoaded()) {
            this.log("No cached ref dat, fetching ..", LogLevel.VERBOSE);
            this.appManager.api.fetchCoreReferenceData(null).subscribe((res) => {
                this.log("Got core ref data. Updating local POIs", LogLevel.VERBOSE);


            }, (rejection) => {
                this.log("Error fetching core ref data:" + rejection);
            });
        }

    }

    showPOIListOnMap(listType: string) {

        var preferredMapHeight = this.getPreferredMapHeight(null);
        //TODO: vary by list type
        this.mapping.refreshMapView(preferredMapHeight, this.poiManager.poiList, null);

        if (!this.mapDisplayed) {
            //TODO:centre map on first load
            this.mapDisplayed = true;
        }

        this.mapping.updateMapSize();

        //force refresh of results list
        this.changeDetector.detectChanges();
    }

    getIconForPOI(poi) {
        return Utils.getIconForPOI(poi);
    }

    getPOIByID(poiID) {
        var poiList = this.poiManager.poiList;
        for (var i = 0; i < poiList.length; i++) {
            if (poiList[i].ID == poiID) {
                return poiList[i];
            }
        }
        return null;
    }


    refreshResultsAfterMapChange() {
        if (!this.searchOnDemand) {
            this.log("Skipping refresh, search on demand disabled..", LogLevel.VERBOSE);
            return;
        } else {
            this.log("Refreshing Results..", LogLevel.VERBOSE);
        }


        this.initialResultsShown = true;
        //this.appState.isSearchInProgress = true;

        var params = new POISearchParams();
        this.mapping.getMapCenter().subscribe((mapcentre) => {
            if (mapcentre != null) {

                params.latitude = mapcentre.coords.latitude;
                params.longitude = mapcentre.coords.longitude;

                //store this as last known map centre
                this.appManager.searchSettings.LastSearchPosition = new GeoLatLng(mapcentre.coords.latitude, mapcentre.coords.longitude);
            }

            /////
            //params.distance = distance;
            // params.distanceUnit = distance_unit;
            // params.maxResults = this.appConfig.maxResults;
            params.includeComments = true;
            params.enableCaching = true;

            //map viewport search on bounding rectangle instead of map centre

            //if (this.appConfig.enableLiveMapQuerying) {
            // if (this.mappingManager.isMapReady()) {
            this.mapping.getMapBounds().subscribe((bounds) => {
                if (bounds != null) {

                    params.boundingbox = "(" + bounds[0].latitude + "," + bounds[0].longitude + "),(" + bounds[1].latitude + "," + bounds[1].longitude + ")";
                    this.log(JSON.stringify(bounds), LogLevel.VERBOSE);

                }
                //close zooms are 1:1 level of detail, zoomed out samples less data
                this.mapping.getMapZoom().subscribe((zoomLevel: number) => {
                    this.log("map zoom level to be converted to level of detail:" + zoomLevel);
                    if (zoomLevel > 10) {
                        params.levelOfDetail = 1;
                    } else if (zoomLevel > 6) {
                        params.levelOfDetail = 3;
                    } else if (zoomLevel > 4) {
                        params.levelOfDetail = 5;
                    } else if (zoomLevel > 3) {
                        params.levelOfDetail = 10;
                    }
                    else {
                        params.levelOfDetail = 20;
                    }
                    //this.log("zoomLevel:" + zoomLevel + "  :Level of detail:" + params.levelOfDetail);
                    //    }
                    //}

                    //apply filter settings from search settings 
                    if (this.appManager.searchSettings != null) {
                        if (this.appManager.searchSettings.ConnectionTypeList != null) {
                            params.connectionTypeIdList = this.appManager.searchSettings.ConnectionTypeList;
                        }

                        if (this.appManager.searchSettings.UsageTypeList != null) {
                            params.usageTypeIdList = this.appManager.searchSettings.UsageTypeList;
                        }

                        if (this.appManager.searchSettings.StatusTypeList != null) {
                            params.statusTypeIdList = this.appManager.searchSettings.StatusTypeList;
                        }

                        if (this.appManager.searchSettings.OperatorList != null) {
                            params.operatorIdList = this.appManager.searchSettings.OperatorList;
                        }

                        if (this.appManager.searchSettings.MinPowerKW != null) {
                            params.minPowerKW = this.appManager.searchSettings.MinPowerKW;
                        }
                        if (this.appManager.searchSettings.MaxPowerKW != null) {
                            params.maxPowerKW = this.appManager.searchSettings.MaxPowerKW;
                        }

                        if (this.journeyManager.getRoutePolyline() != null) {
                            //when searching along a polyline we discard any other bounding box filters etc
                            params.polyline = this.journeyManager.getRoutePolyline();
                            params.boundingbox = null;
                            params.levelOfDetail = null;
                            params.latitude = null;
                            params.longitude = null;
                            // params.distance = this.routeSearchDistance;
                        }

                        /*
                        if ($("#filter-submissionstatus").val() != 200) params.submissionStatusTypeID = $("#filter-submissionstatus").val();
                        if ($("#filter-connectionlevel").val() != "") params.levelID = $("#filter-connectionlevel").val();
                        */

                    }

                    //TODO: use stack of requests as may be multiple in sync
                    this.appManager.isRequestInProgress = true;
                    this.poiManager.fetchPOIList(params);
                });



            })
                , (err) => {
                    this.appManager.showToastNotification(this.nav, "Arrgh, couldn't get map centre.");
                }

        }, (error) => {
            this.log("No map centre, can't begin refresh." + error);

        });


    }

    viewPOIDetails(args: any) {


        this.log("Viewing/fetching [" + this.poiViewMode + "] POI Details " + args.poiId);


        this.poiManager.getPOIById(args.poiId, true).subscribe(poi => {

            this.log("Got POI Details " + poi.ID);

            if (this.poiViewMode == "modal") {
                this.searchOnDemand = false; //suspend interactive searches while modal dialog active

                let poiDetailsModal = Modal.create(POIDetailsPage, { item: poi });

                poiDetailsModal.onDismiss((data) => {
                    //should focus map again..
                    this.log("Dismissing POI Details.");
                    this.mapping.focusMap();
                    this.searchOnDemand = true;
                });
                this.mapping.unfocusMap();

                this.zone.run(() => {
                    this.nav.present(poiDetailsModal);
                });
            }
            if (this.poiViewMode == "side") {
                this.zone.run(() => {
                    this.selectedPOI = poi;
                });
            }

        }, (err) => {

            this.appManager.showToastNotification(this.nav, "POI Details not available");
        });


    }

    closePOIDetails() {
        this.selectedPOI = null;
    }

    openSearchOptions() {
        this.nav.push(SettingsPage);
    }

    openSideView() {
        this.poiViewMode = "side";
        this.mapping.updateMapSize();
    }
    closeSideView() {
        this.poiViewMode = "modal";
        this.mapping.updateMapSize();
    }

    planRoute() {
        this.routePlanningMode = true;
    }

    locateUser(): Promise<any> {

        var geoPromise = new Promise((resolve, reject) => {
            this.log("Attempting to locate user..");
            navigator.geolocation.getCurrentPosition(resolve, reject);
        }).then((position: any) => {
            this.log("Got user location.");

            this.mapping.updateMapCentrePos(position.coords.latitude, position.coords.longitude, true);
            this.mapping.setMapZoom(15); //TODO: provider specific ideal zoom for 'summary'
            //this.mapping.updateMapSize();

            this.showPOIListOnMap(null);//show initial map view

            // this.refreshResultsAfterMapChange(); //fetch new poi results based on map viewport
        }).catch((err) => {
            ///no geolocation
            this.log("Failed to get user location.");
            this.appManager.showToastNotification(this.nav, "Your location could not be determined.")

            //use a default location, or the last known search position if known
            var searchPos = new GeoLatLng(37.415328, -122.076575);
            if (this.appManager.searchSettings.LastSearchPosition != null) {
                searchPos = this.appManager.searchSettings.LastSearchPosition;
            }

            this.appManager.searchSettings.LastSearchPosition = searchPos;
            this.mapping.updateMapCentrePos(searchPos.latitude, searchPos.longitude, true);
            this.mapping.setMapZoom(15);

            this.refreshResultsAfterMapChange();
            //this.mapping.updateMapSize();

        });

        return geoPromise;

    }

    placeSelected(place) {

        this.log("Got place details:" + place.name);


        //give map back the input focus (mainly for native map)
        this.mapping.focusMap();

        this.mapping.updateMapCentrePos(place.geometry.location.lat(), place.geometry.location.lng(), true);
        this.refreshResultsAfterMapChange();
        ///this.mapping.setMapZoom(15);
        //this.debouncedRefreshResults();




    }

}