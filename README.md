![Logo](admin/schlueter-thermostat.png)
# ioBroker.schlueter-thermostat

[![NPM version](https://img.shields.io/npm/v/iobroker.schlueter-thermostat.svg)](https://www.npmjs.com/package/iobroker.schlueter-thermostat)
[![Downloads](https://img.shields.io/npm/dm/iobroker.schlueter-thermostat.svg)](https://www.npmjs.com/package/iobroker.schlueter-thermostat)
![Number of Installations](https://iobroker.live/badges/schlueter-thermostat-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/schlueter-thermostat-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.schlueter-thermostat.png?downloads=true)](https://nodei.co/npm/iobroker.schlueter-thermostat/)

**Tests:** ![Test and Release](https://github.com/patricknitsch/ioBroker.schlueter-thermostat/workflows/Test%20and%20Release/badge.svg)

## schlueter-thermostat adapter for ioBroker

Floor heating controlled with Ditra Heat Thermostat

### Installation

1) Download the app "Schlueter-HEAT-CONTROL from the App-Store, create an account by entering a username and a password. Note down username and password
2) In the app, add/connect your thermostat per Thermostat ID or QR-Code
3) In the app, identify your customer id under
Menu > Thermostat data > [Thermostat Name] > Customer ID
(mine was “3”)
4) In the app, identify your customer id under
Menu > Thermostat data > [Thermostat Name] > Softwareversion
5) Install the adapter in IOBroker
6) Fill in username, password, Customer ID and Softwareversion. API-Key is given.

7) Optionally you can fetch the Schedule and Energy Consumption for the device.
Therefore active the checkboxes.

The API and the values can be checked under the following address.
(https://ocd5.azurewebsites.net/swagger/ui/index#)

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
* (patricknitsch) initial release
* (patricknitsch) fetch data and write in Datapoints

## License
MIT License

Copyright (c) 2026 patricknitsch <patricknitsch@web.de>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.